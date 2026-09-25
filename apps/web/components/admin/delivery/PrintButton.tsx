'use client';

// Opens the browser's print dialog. On a phone that same dialog saves a PDF,
// which Yuval shares with the courier herself (SEC-016: no link in MVP).
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className="btn btn-primary" onClick={() => window.print()} data-testid="delivery-print">
      {label}
    </button>
  );
}
