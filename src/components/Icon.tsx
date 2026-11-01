import { ICONS, type IconName } from "./icons";

interface IconProps {
  name: IconName;
  size?: number;
  stroke?: number;
  className?: string;
}

/** Decorative inline SVG icon. Give the surrounding control an aria-label. */
export function Icon({ name, size = 16, stroke = 2.25, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flex: "none" }}
      // Static, trusted markup from icons.ts.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
