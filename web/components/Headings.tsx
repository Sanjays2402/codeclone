import { clsx } from "clsx";

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={clsx("eyebrow", className)}>{children}</span>;
}

export function H1({ eyebrow, children }: { eyebrow?: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      {eyebrow && <div className="mb-1.5"><Eyebrow>{eyebrow}</Eyebrow></div>}
      <h1 className="text-[28px] leading-[1.1] tracking-[-0.018em] font-medium">{children}</h1>
    </div>
  );
}

export function H2({ eyebrow, children, right }: { eyebrow?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mt-10 mb-3 flex items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="mb-1"><Eyebrow>{eyebrow}</Eyebrow></div>}
        <h2 className="text-[17px] leading-tight tracking-tight font-medium">{children}</h2>
      </div>
      {right}
    </div>
  );
}
