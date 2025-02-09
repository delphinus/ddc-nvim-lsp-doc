import { autocmd, Denops, fn, nvimFn, once, op, vars } from "./deps.ts";
import {
  CompleteInfo,
  CompletionItem,
  FloatOption,
  MarkupContent,
  PopupPos,
  SignatureHelp,
  UserData,
} from "./types.ts";
import { Float } from "./float.ts";

interface ServerCapabilities {
  signatureHelpProvider?: SignatureHelpOptions;
}

export type SignatureHelpOptions = {
  triggerCharacters?: string[];
  retriggerCharacters?: string[];
};

export function trimLines(lines: string[] | undefined): string[] {
  if (!lines) return [];
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

// TODO: support commit character
// ex: [ ",", "(", "<" ]
export function findParen(line: string): number {
  return line.search(/\((([^\(\)]*)|(\([^\(\)]*\)))*$/);
}

export class DocHandler {
  private float = new Float();
  private winName = "ddc_nvim_lsp_doc_document_winid";

  async closeWin(denops: Denops) {
    this.float.closeWin(denops);
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
    const maxWidth = Math.min(
      await op.columns.get(denops) - col,
      await vars.g.get(denops, "ddc_nvim_lsp_doc#max_winwidth", 80) as number,
    );
    const maxHeight = Math.min(
      await denops.eval("&lines") as number - pumInfo.row,
      await vars.g.get(denops, "ddc_nvim_lsp_doc#max_winheight", 30) as number,
    );
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
      maxHeight: maxHeight,
    });
  }
}

export class SigHelpHandler {
  private float = new Float();
  private winName = "ddc_nvim_lsp_doc_sighelp_winid";
  private prevItem: SignatureHelp = {} as SignatureHelp;

  onInsertEnter() {
    this.prevItem = {} as SignatureHelp;
  }

  async requestSighelp(denops: Denops, col: number) {
    denops.call(
      "luaeval",
      "require('ddc_nvim_lsp_doc.helper').get_signature_help(_A.arg)",
      { arg: { col: col } },
    );
  }
  async closeWin(denops: Denops) {
    this.float.closeWin(denops);
  }

  isSameSignature(item: SignatureHelp) {
    if (!this.prevItem || !this.prevItem.signatures) return false;
    return this.prevItem.signatures[0].label == item.signatures[0].label;
  }

  isSamePosition(item: SignatureHelp) {
    const isSame = item.activeSignature == this.prevItem.activeSignature &&
      item.activeParameter == this.prevItem.activeParameter;
    return isSame;
  }

  async showSignatureHelp(
    denops: Denops,
    info: SighelpResponce,
  ): Promise<void> {
    const col = info.startpos;
    info.lines = trimLines(info.lines);
    if (
      !info.lines.length || !(await fn.mode(denops) as string).startsWith("i")
    ) {
      this.closeWin(denops);
      return;
    }

    if (this.isSameSignature(info.help)) {
      if (this.isSamePosition(info.help)) {
        return;
      } else {
        this.float.changeHighlight(denops, info.hl);
        this.prevItem = info.help;
        return;
      }
    }
    this.prevItem = info.help;

    let floatingOpt: FloatOption = {
      relative: "win",
      anchor: "SW",
      style: "minimal",
      row: await fn.winline(denops) - 1,
      col: col,
    };
    await this.float.showFloating(denops, {
      syntax: "markdown",
      lines: info.lines,
      floatOpt: floatingOpt,
      events: ["InsertLeave", "CursorMoved"],
      winName: this.winName,
      hl: info.hl,
      maxWidth: await op.columns.get(denops),
      maxHeight: await fn.winline(denops),
    });
  }
}

export type DocResponce = {
  item: CompletionItem;
  selected: number;
};

export type SighelpResponce = {
  item: CompletionItem;
  selected: number;
  help: SignatureHelp;
  lines?: string[];
  hl?: [number, number];
  startpos: number;
};

export class EventHandler {
  private timer: number = 0;
  private prevInput = "";
  private sighelpHandler = new SigHelpHandler();
  private docHandler = new DocHandler();
  private capabilities = {} as ServerCapabilities;
  private selected = -1;

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
    this.selected = info.selected;
    return decoded["lspitem"];
  }

  private async getCapabilities(denops: Denops) {
    this.capabilities = await denops.call(
      "luaeval",
      "require('ddc_nvim_lsp_doc.helper').get_capabilities()",
    ) as ServerCapabilities;
  }

  private async onCompleteChanged(denops: Denops): Promise<void> {
    if (
      !(await vars.g.get(denops, "ddc_nvim_lsp_doc#enable_documentation", 1))
    ) {
      return;
    }
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
        denops.call(
          "luaeval",
          "require('ddc_nvim_lsp_doc.helper').get_resolved_item(_A.arg)",
          { arg: { decoded: decoded } },
        );
      }
    }, 50);
  }

  private async onInsertEnter(denops: Denops): Promise<void> {
    this.prevInput = "";
    await this.getCapabilities(denops);
    if (this.capabilities && this.capabilities.signatureHelpProvider) {
      this.sighelpHandler.requestSighelp(denops, await fn.col(denops, "."));
    }
  }

  private async onTextChanged(denops: Denops): Promise<void> {
    if (
      !(await vars.g.get(denops, "ddc_nvim_lsp_doc#enable_signaturehelp", 1) ||
        !this.capabilities || !this.capabilities.signatureHelpProvider)
    ) {
      return;
    }
    const cursorCol = await fn.col(denops, ".");
    const line = await fn.getline(denops, ".");
    const input = line.slice(0, cursorCol - 1);
    if (input == this.prevInput) return;

    const startPos = findParen(input);
    if (startPos != -1) {
      this.prevInput = input;
      this.sighelpHandler.requestSighelp(denops, startPos);
    } else {
      this.sighelpHandler.closeWin(denops);
    }
  }

  async onEvent(denops: Denops, event: autocmd.AutocmdEvent): Promise<void> {
    if (event == "InsertEnter") {
      this.onInsertEnter(denops);
      this.sighelpHandler.onInsertEnter();
    } else {
      if (!this.capabilities) {
        await this.getCapabilities(denops);
      }
      if (event == "CompleteChanged") {
        this.onCompleteChanged(denops);
      } else if (event == "TextChangedI" || event == "TextChangedP") {
        this.onTextChanged(denops);
      }
    }
  }

  async onDocResponce(denops: Denops, arg: DocResponce) {
    if (arg.selected != this.selected) {
      this.docHandler.showCompleteDoc(denops, arg.item);
    }
  }

  async onSighelpResponce(denops: Denops, arg: SighelpResponce) {
    this.sighelpHandler.showSignatureHelp(denops, arg);
  }
}
