import { autocmd, Denops, fn, nvimFn, once, op, vars } from "./deps.ts";
import {
  CompleteInfo,
  CompletionItem,
  FloatOption,
  MarkupContent,
  OpenFloatOptions,
  PopupPos,
  SignatureResponse,
  UserData,
} from "./types.ts";
import { Float } from "./float.ts";

export function trimLines(lines: string[]): string[] {
  let start = 0;
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length) {
      start = i;
      break;
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length) {
      end = i + 1;
      break;
    }
  }
  return lines.slice(start, end);
}

export function findParen(line: string): number {
  return line.search(/\((([^\(\)]*)|(\([^\(\)]*\)))*$/);
}

export class DocHandler {
  private float = new Float();
  private winName = "ddc_nvim_lsp_doc_document_winid";

  async closeWin(denops: Denops) {
    this.float.closeWin(denops, this.winName);
  }

  async showCompleteDoc(denops: Denops, item: CompletionItem) {
    let detail = "";
    let syntax: string = "markdown";
    if (item.detail) {
      detail = item.detail;
    }
    let arg: string | MarkupContent;
    if (item.documentation) {
      const doc = item.documentation;
      if (typeof doc == "string") {
        arg = detail + (detail.length && doc.length ? "\n---\n" : "") + doc;
        syntax = "";
      } else {
        arg = {
          kind: syntax,
          value: detail + (detail.length && doc.value.length ? "\n---\n" : "") +
            doc.value,
        } as MarkupContent;
        syntax = doc.kind;
      }
    } else if (detail.length) {
      arg = detail;
    } else {
      this.closeWin(denops);
      return;
    }

    const lines = trimLines(
      await denops.call(
        "luaeval",
        "vim.lsp.util.convert_input_to_markdown_lines(_A.arg)",
        { arg: arg },
      ) as string[],
    );
    if (!lines.length) {
      this.closeWin(denops);
      return;
    }

    const pumInfo = await denops.call("pum_getpos") as PopupPos;
    if (!pumInfo || !pumInfo.col) {
      this.closeWin(denops);
      return;
    }
    // const align = "right";

    const col = pumInfo.col + pumInfo.width + (pumInfo.scrollbar ? 1 : 0);
    const maxWidth = await op.columns.get(denops) - col;
    let floatingOpt: FloatOption = {
      relative: "editor",
      anchor: "NW",
      style: "minimal",
      row: pumInfo.row,
      col: col,
    };
    this.float.showFloating(denops, {
      syntax: syntax,
      lines: lines,
      floatOpt: floatingOpt,
      events: ["InsertLeave", "CursorMovedI"],
      winName: this.winName,
      maxWidth: maxWidth,
      maxHeight: await denops.eval("&lines") as number - pumInfo.row,
    });
  }
}

export class SigHelpHandler {
  private float = new Float();
  private winName = "ddc_nvim_lsp_doc_sighelp_winid";

  async closeWin(denops: Denops) {
    this.float.closeWin(denops, this.winName);
  }

  async showSignatureHelp(
    denops: Denops,
    info: SignatureResponse,
    col: number,
  ): Promise<void> {
    if (!info.lines || !(await fn.mode(denops) as string).startsWith("i")) {
      this.closeWin(denops);
      return;
    }
    info.lines = trimLines(info.lines);
    if (!info.lines.length) {
      this.closeWin(denops);
      return;
    }

    let floatingOpt: FloatOption = {
      relative: "win",
      anchor: "SW",
      style: "minimal",
      row: await fn.winline(denops) - 1,
      col: col,
    };
    this.float.showFloating(denops, {
      syntax: "markdown",
      lines: info.lines,
      floatOpt: floatingOpt,
      events: ["InsertLeave"],
      winName: this.winName,
      hl: info.hl,
      maxWidth: await op.columns.get(denops),
      maxHeight: await fn.winline(denops),
    });
  }
}

export class Hover {
  private timer: number = 0;
  private prevInput = "";
  private sighelpHandler = new SigHelpHandler();
  private docHandler = new DocHandler();

  private async luaAsyncRequest(
    denops: Denops,
    funcName: string,
    args: unknown[],
    callback: Function,
  ): Promise<void> {
    denops.call("luaeval", `${funcName}(_A.args, _A.callback)`, {
      args: args,
      callback: once(denops, async (response) => {
        return callback(response);
      })[0],
    });
  }

  private async getDecodedCompleteItem(
    denops: Denops,
  ): Promise<CompletionItem | null> {
    const info = await fn.complete_info(denops, [
      "mode",
      "selected",
      "items",
    ]) as CompleteInfo;
    if (
      info["mode"] != "eval" ||
      info["selected"] == -1
    ) {
      return null;
    }
    const item = info["items"][info["selected"]];
    if (!item.user_data || typeof item.user_data !== "string") return null;
    const decoded = JSON.parse(item.user_data) as UserData;
    if (!decoded["lspitem"]) return null;
    return decoded["lspitem"];
  }

  private async onCompleteChanged(denops: Denops): Promise<void> {
    // debounce
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const decoded = await this.getDecodedCompleteItem(denops);
      if (!decoded) {
        this.docHandler.closeWin(denops);
        return;
      }

      if (decoded.documentation) {
        this.docHandler.showCompleteDoc(denops, decoded);
      } else {
        this.luaAsyncRequest(
          denops,
          "require('ddc_nvim_lsp_doc.hover').get_resolved_item",
          [decoded],
          (res: CompletionItem) => {
            if (res) {
              this.docHandler.showCompleteDoc(denops, res);
            }
          },
        );
      }
    }, 100);
  }

  private async onInsertEnter(_denops: Denops): Promise<void> {
    this.prevInput = "";
  }

  private async onTextChanged(denops: Denops): Promise<void> {
    const cursorCol = await fn.col(denops, ".");
    const line = await fn.getline(denops, ".");
    const input = line.slice(0, cursorCol - 1);
    if (input == this.prevInput) return;

    const startPos = findParen(input);
    if (startPos != -1) {
      this.prevInput = input;
      this.luaAsyncRequest(
        denops,
        "require('ddc_nvim_lsp_doc.hover').get_signature_help",
        [],
        (res: SignatureResponse) => {
          if (res) {
            this.sighelpHandler.showSignatureHelp(denops, res, startPos);
          }
        },
      );
    } else {
      this.sighelpHandler.closeWin(denops);
    }
  }

  async onEvent(denops: Denops, event: autocmd.AutocmdEvent): Promise<void> {
    if (event == "CompleteChanged") {
      this.onCompleteChanged(denops);
    } else if (event == "InsertEnter") {
      this.onInsertEnter(denops);
    } else if (event == "TextChangedI" || event == "TextChangedP") {
      this.onTextChanged(denops);
    }
  }
}
