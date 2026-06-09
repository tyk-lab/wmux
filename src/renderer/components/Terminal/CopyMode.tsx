interface CopyModeProps {
  active: boolean;
}

export default function CopyMode({ active }: CopyModeProps) {
  if (!active) return null;
  return (
    <div className="copy-mode-indicator">psmux copy mode - mouse wheel / arrows to scroll, Esc to exit</div>
  );
}
