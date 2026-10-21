// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteContext, ComponentsContext, UploadTab, type ComponentProps } from "@blocknote/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ContextType, ReactNode } from "react";
import { expect, it, vi } from "vitest";

it("settles native file-panel cancellation without replacing the existing file or showing failure", async () => {
  let finish!: (url: string) => void;
  const editor = BlockNoteEditor.create({
    initialContent: [{ id: "media", type: "file", props: { url: "/api/attachments/existing", name: "existing.txt" } }],
    uploadFile: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  });
  const host = document.body.appendChild(document.createElement("div"));
  editor.mount(host);
  const update = vi.spyOn(editor, "updateBlock"),
    loading = vi.fn();
  const components = {
    FilePanel: {
      TabPanel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      FileInput: ({ onChange }: ComponentProps["FilePanel"]["FileInput"]) => (
        <button onClick={() => onChange(new File(["replacement"], "replacement.txt"))}>Choose replacement</button>
      ),
    },
  } as unknown as ContextType<typeof ComponentsContext>;
  try {
    const mounted = render(
      <BlockNoteContext.Provider value={{ editor }}>
        <ComponentsContext.Provider value={components}>
          <UploadTab blockId="media" setLoading={loading} />
        </ComponentsContext.Provider>
      </BlockNoteContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose replacement" }));
    expect(loading).toHaveBeenLastCalledWith(true);
    await act(async () => finish(""));
    expect(loading).toHaveBeenLastCalledWith(false);
    expect(update).not.toHaveBeenCalled();
    expect(editor.getBlock("media")?.props).toMatchObject({ url: "/api/attachments/existing", name: "existing.txt" });
    expect(mounted.container.querySelector(".bn-error-text")).toBeNull();
    mounted.unmount();
  } finally {
    update.mockRestore();
    editor.unmount();
    host.remove();
  }
});
