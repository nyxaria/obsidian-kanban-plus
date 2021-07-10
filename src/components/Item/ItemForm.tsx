import React from "react";
import {
  MarkdownSourceView,
  parseLinktext,
  TFile,
  htmlToMarkdown,
} from "obsidian";
import useOnclickOutside from "react-cool-onclickoutside";

import { Item } from "../types";
import { c, generateInstanceId } from "../helpers";
import { useAutocompleteInputProps } from "./autocomplete";
import { KanbanContext } from "../context";
import { t } from "src/lang/helpers";
import { KanbanView } from "src/KanbanView";

function linkTo(
  view: KanbanView,
  file: TFile,
  sourcePath: string,
  subpath?: string
) {
  // Generate a link relative to this Kanban board, respecting user link type preferences
  return view.app.fileManager.generateMarkdownLink(file, sourcePath, subpath);
}

function getMarkdown(view: KanbanView, transfer: DataTransfer, html: string) {
  // 0.12.5 -- remove handleDataTransfer below when this version is more widely supported
  if (htmlToMarkdown) {
    return htmlToMarkdown(html);
  }

  // crude hack to use Obsidian's html-to-markdown converter (replace when Obsidian exposes it in API):
  return (MarkdownSourceView.prototype as any).handleDataTransfer.call(
    { app: view.app },
    transfer
  );
}

function fixBulletsAndLInks(text: string) {
  // Internal links from e.g. dataview plugin incorrectly begin with `app://obsidian.md/`, and
  // we also want to remove bullet points and task markers from text and markdown
  return text
    .replace(/^\s*[-+*]\s+(\[.]\s+)?/, "")
    .trim()
    .replace(/^\[(.*)\]\(app:\/\/obsidian.md\/(.*)\)$/, "[$1]($2)");
}

function dropAction(view: KanbanView, transfer: DataTransfer) {
  // Return a 'copy' or 'link' action according to the content types, or undefined if no recognized type
  if (transfer.types.includes("text/uri-list")) return "link";
  if (
    ["file", "files", "link"].includes(
      (view.app as any).dragManager.draggable?.type
    )
  )
    return "link";
  if (
    transfer.types.includes("text/html") ||
    transfer.types.includes("text/plain")
  )
    return "copy";
}

function importLines(
  view: KanbanView,
  filePath: string,
  transfer: DataTransfer,
  forcePlaintext: boolean = false
): string[] {
  const draggable = (view.app as any).dragManager.draggable;
  const html = transfer.getData("text/html");
  const plain = transfer.getData("text/plain");
  const uris = transfer.getData("text/uri-list");

  switch (draggable?.type) {
    case "file":
      return [linkTo(view, draggable.file, filePath)];
    case "files":
      return draggable.files.map((f: TFile) => linkTo(view, f, filePath));
    case "link":
      let link = draggable.file
        ? linkTo(
            view,
            draggable.file,
            parseLinktext(draggable.linktext).subpath
          )
        : `[[${draggable.linktext}]]`;
      let alias = new DOMParser().parseFromString(html, "text/html")
        .documentElement.textContent; // Get raw text
      link = link
        .replace(/]]$/, `|${alias}]]`)
        .replace(/^\[[^\]].+]\(/, `[${alias}](`);
      return [link];
    default:
      const text = forcePlaintext
        ? plain || html
        : getMarkdown(view, transfer, html);
      // Split lines and strip leading bullets/task indicators
      const lines: string[] = (text || uris || plain || html || "")
        .split(/\r\n?|\n/)
        .map(fixBulletsAndLInks);
      return lines.filter((line) => line);
  }
}

interface ItemFormProps {
  addItems: (items: Item[]) => void;
}

export function ItemForm({ addItems }: ItemFormProps) {
  const [isInputVisible, setIsInputVisible] = React.useState(false);
  const [itemTitle, setItemTitle] = React.useState("");
  const { view, filePath } = React.useContext(KanbanContext);

  const clickOutsideRef = useOnclickOutside(
    () => {
      setIsInputVisible(false);
    },
    {
      ignoreClass: c("ignore-click-outside"),
    }
  );

  const clear = () => {
    setItemTitle("");
    setIsInputVisible(false);
  };

  const createItem = () => {
    const title = itemTitle.trim();

    if (title) {
      addItemsFromStrings([title]);
      setItemTitle("");
    }
  };

  const autocompleteProps = useAutocompleteInputProps({
    isInputVisible,
    onEnter: createItem,
    onEscape: clear,
  });

  const selectionStart = React.useRef<number>(null);
  const selectionEnd = React.useRef<number>(null);

  React.useLayoutEffect(() => {
    if (selectionStart.current && selectionEnd.current) {
      autocompleteProps.ref.current?.setSelectionRange(
        selectionStart.current,
        selectionEnd.current
      );
    }
  }, [itemTitle]);

  const addItemsFromStrings = (titles: string[]) => {
    addItems(titles.map((title) => view.parser.newItem(title)));
  };

  if (isInputVisible) {
    return (
      <div ref={clickOutsideRef}>
        <div className={c("item-input-wrapper")}>
          <div data-replicated-value={itemTitle} className={c("grow-wrap")}>
            <textarea
              rows={1}
              value={itemTitle}
              className={c("item-input")}
              placeholder={t("Item title...")}
              onChange={(e) => {
                selectionStart.current = e.target.selectionStart;
                selectionEnd.current = e.target.selectionEnd;
                setItemTitle(e.target.value.replace(/[\r\n]+/g, " "));
              }}
              onDragOver={(e) => {
                const action = dropAction(view, e.dataTransfer);

                if (action) {
                  e.dataTransfer.dropEffect = action;
                  e.preventDefault();
                  return false;
                }
              }}
              onDragLeave={() => {
                if (!itemTitle) setIsInputVisible(false);
              }}
              onDrop={(e) => {
                // shift key to force plain text, the same way Obsidian does it
                addItemsFromStrings(
                  importLines(view, filePath, e.dataTransfer, e.shiftKey)
                );
                if (!itemTitle) setIsInputVisible(false);
              }}
              onPaste={(e) => {
                const html = e.clipboardData.getData("text/html");
                const pasteLines = importLines(view, filePath, e.clipboardData);
                if (pasteLines.length > 1) {
                  addItemsFromStrings(pasteLines);
                  e.preventDefault();
                  return false;
                } else if (html) {
                  // We want to use the markdown instead of the HTML, but you can't intercept paste
                  // So we have to simulate a paste event the hard way
                  const input = e.target as HTMLTextAreaElement;
                  const paste = pasteLines.join("");

                  selectionStart.current = input.selectionStart;
                  selectionEnd.current = input.selectionEnd;

                  const replace =
                    itemTitle.substr(0, selectionStart.current) +
                    paste +
                    itemTitle.substr(selectionEnd.current);

                  selectionStart.current = selectionEnd.current =
                    selectionStart.current + paste.length;

                  setItemTitle(replace);

                  // And then cancel the default event
                  e.preventDefault();
                  return false;
                }
                // plain text/other, fall through to standard cut/paste
              }}
              {...autocompleteProps}
            />
          </div>
        </div>
        <div className={c("item-input-actions")}>
          <button className={c("item-action-add")} onClick={createItem}>
            {t("Add item")}
          </button>
          <button className={c("item-action-cancel")} onClick={clear}>
            {t("Cancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={c("item-button-wrapper")}>
      <button
        className={c("new-item-button")}
        onClick={() => setIsInputVisible(true)}
        onDragOver={(e) => {
          if (dropAction(view, e.dataTransfer)) {
            setIsInputVisible(true);
          }
        }}
      >
        <span className={c("item-button-plus")}>+</span> {t("Add a card")}
      </button>
    </div>
  );
}
