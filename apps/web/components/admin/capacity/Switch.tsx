'use client';

// On/off switch (design-tokens.md "מתג on/off"): 52x44 hit area, 32px track.
// RTL: the knob sits on the inline-start side (the right) when off, and moves
// to inline-end when on. The mockup drew it on the left; this follows the spec.
export function Switch({
  checked,
  onChange,
  labelledBy,
  testId,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  labelledBy: string;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      className="admin-switch"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}
