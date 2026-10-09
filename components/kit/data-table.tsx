// A table on a computer, a stack of cards on a phone: the same rows and cells
// either way, so a page writes its list once. On a phone the `main` cell leads
// each card, cells with a `label` show as "LABEL  value" lines under it, and
// `end` cells (buttons) close the card.

export function DataTable({ columns, children }: { columns: React.ReactNode[]; children: React.ReactNode }) {
  return (
    <div className="border border-line bg-raised">
      <table className="w-full text-sm max-md:block">
        <thead className="border-b border-line text-left max-md:hidden">
          <tr>
            {columns.map((column, i) => (
              <th key={i} className="label px-3 py-2.5 font-normal">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft max-md:block">{children}</tbody>
      </table>
    </div>
  );
}

export function DataRow({ children }: { children: React.ReactNode }) {
  return <tr className="align-top max-md:flex max-md:flex-col max-md:gap-2 max-md:px-4 max-md:py-3.5">{children}</tr>;
}

export function DataCell({
  label,
  main = false,
  end = false,
  className = "",
  children,
}: {
  /** Shown before the value on a phone, where there's no header row. */
  label?: string;
  /** Leads the card on a phone. */
  main?: boolean;
  /** Buttons: right-aligned on a computer, the card's last line on a phone. */
  end?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (main) return <td className={`px-3 py-2.5 max-md:p-0 ${className}`}>{children}</td>;
  return (
    <td className={`px-3 py-2.5 max-md:flex max-md:items-baseline max-md:gap-3 max-md:p-0 ${end ? "md:text-right max-md:pt-1" : ""} ${className}`}>
      {label && <span className="label w-24 shrink-0 md:hidden">{label}</span>}
      <div className="min-w-0 max-md:flex-1">{children}</div>
    </td>
  );
}
