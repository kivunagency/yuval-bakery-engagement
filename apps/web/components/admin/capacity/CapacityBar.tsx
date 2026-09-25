import { useTranslations } from 'next-intl';

// One resource's capacity bar (design-tokens.md "ניהול"): a segment per order,
// width proportional to its minutes, alternating ink shades; the free part is
// a dashed outline. The bar is aria-hidden: the sentence under it is what a
// screen reader reads.
export function CapacityBar({
  resource,
  total,
  reserved,
  unpaid,
  segments,
  isBlackout,
  orderCount,
}: {
  resource: 'oven' | 'work';
  total: number;
  reserved: number;
  unpaid: number;
  segments: { key: string; minutes: number }[];
  isBlackout: boolean;
  orderCount: number;
}) {
  const t = useTranslations('admin.capacity');
  const known = segments.reduce((a, s) => a + s.minutes, 0);
  // If the ledger holds more than the listed orders (should not happen), show the rest as one segment.
  const all = reserved > known ? [...segments, { key: 'other', minutes: reserved - known }] : segments;
  const free = Math.max(0, total - reserved);
  return (
    <div className="admin-res" data-testid={`capacity-${resource}`}>
      <div className="admin-res-h">
        <b>{t(`resource.${resource}`)}</b>
        <span className="num">{t('used_of_total', { used: reserved, total })}</span>
      </div>
      <BarSvg total={total} segments={all} free={free} />
      <p className="admin-bar-legend" data-testid={`capacity-${resource}-sentence`}>
        {resource === 'oven' ? `${t('orders_count', { count: orderCount })} ` : null}
        {isBlackout ? t('sentence_closed') : t(`sentence_free_${resource}`, { free, total })}
        {unpaid > 0 ? ` ${t(`sentence_unpaid_${resource}`, { unpaid })}` : null}
      </p>
    </div>
  );
}

// SVG, not styled divs: the CSP has no 'unsafe-inline' for styles, so a
// server-rendered style="width: 30%" would be dropped. Geometry attributes are
// not styles. Drawn from the right (RTL): the first order starts at the
// inline-start edge, the free part is at the inline-end.
const W = 1000;
const GAP = 5;
function BarSvg({ total, segments, free }: { total: number; segments: { key: string; minutes: number }[]; free: number }) {
  const scale = total > 0 ? W / Math.max(total, segments.reduce((a, s) => a + s.minutes, 0)) : 0;
  let right = W;
  const rects = segments
    .filter((s) => s.minutes > 0)
    .map((s, i) => {
      const w = s.minutes * scale;
      const x = right - w;
      right = x;
      return <rect key={s.key} className={`admin-bar-seg admin-bar-seg-${i % 3}`} x={x} y={0} width={Math.max(0, w - GAP)} height={28} />;
    });
  return (
    <svg className="admin-bar" viewBox={`0 0 ${W} 28`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {rects}
      {free > 0 && total > 0 ? (
        <rect className="admin-bar-free" x={1} y={1} width={Math.max(0, right - 2)} height={26} rx={0} vectorEffect="non-scaling-stroke" />
      ) : null}
    </svg>
  );
}
