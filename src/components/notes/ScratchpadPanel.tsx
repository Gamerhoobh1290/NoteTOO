import { X } from 'lucide-react';
import { SCRATCHPAD } from '../../fs/paths';
import { useApp } from '../../state/AppContext';
import { NoteEditor } from './NoteEditor';

/** Global notepad (`<root>/_scratchpad.md`) sliding over the right side, usable next to any file. */
export function ScratchpadPanel() {
  const { setPanels } = useApp();
  const close = () => setPanels({ scratchpad: false });
  return (
    <aside
      className="scratchpad"
      aria-label="Scratchpad"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <button className="icon-btn small scratch-close" aria-label="Close scratchpad" title="Close (Esc / Alt+3)" onClick={close}>
        <X size={15} />
      </button>
      <NoteEditor path={SCRATCHPAD} title="Scratchpad" compact />
    </aside>
  );
}
