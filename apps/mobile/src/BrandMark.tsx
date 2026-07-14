// Muse 品牌标记：渐变圆角 tile + 由上升创作笔画构成、仍可读作「M」的字形，
// 右上角点缀一颗暖色创作火花，呼应「缪斯 / 创作伙伴」定位。
// 各端各保留一份副本，遵循本仓库「各端各自复制 UI」的惯例。

type MuseMarkProps = {
  size?: number;
  className?: string;
  /** 是否渲染右上角火花，默认渲染。 */
  spark?: boolean;
};

let markSeq = 0;

// 渐变圆角 tile 版：用于图标栏、登录页等需要独立品牌方块的场景。
export function MuseMark({
  size = 36,
  className,
  spark = true,
}: MuseMarkProps) {
  // 每个实例生成唯一 gradient id，避免同页多个 Logo 的 <defs> 冲突。
  const uid = `muse-mark-${(markSeq += 1)}`;

  return (
    <svg
      aria-hidden="true"
      className={className}
      height={size}
      viewBox="0 0 48 48"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`${uid}-tile`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#8B7CFF" />
          <stop offset="1" stopColor="#6FB0FF" />
        </linearGradient>
        <linearGradient id={`${uid}-glass`} x1="0.5" x2="0.5" y1="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.98" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.82" />
        </linearGradient>
      </defs>

      {/* 渐变底 tile + 顶部高光 */}
      <rect
        fill={`url(#${uid}-tile)`}
        height="46"
        rx="13"
        width="46"
        x="1"
        y="1"
      />
      <rect
        fill="#FFFFFF"
        height="22"
        opacity="0.14"
        rx="13"
        width="46"
        x="1"
        y="1"
      />

      {/* 由两道上升笔画构成的「M」，末端上扬如创作的火花轨迹 */}
      <path
        d="M12 34 L12 17 Q12 14 15 15.4 L24 21 L33 15.4 Q36 14 36 17 L36 34"
        fill="none"
        stroke={`url(#${uid}-glass)`}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="4.4"
      />

      {/* 右上创作火花 */}
      {spark ? (
        <path
          d="M35 9 L36.4 12.2 L39.6 13.6 L36.4 15 L35 18.2 L33.6 15 L30.4 13.6 L33.6 12.2 Z"
          fill="#F5C97B"
        />
      ) : null}
    </svg>
  );
}

type MuseWordmarkProps = {
  size?: number;
  className?: string;
  /** 副标题文案，默认 "AI Creative Studio"。 */
  tagline?: string;
};

// 图标 + 文字组合版：用于顶部品牌区。
export function MuseWordmark({
  size = 34,
  className,
  tagline = "AI Creative Studio",
}: MuseWordmarkProps) {
  return (
    <div className={className ? `muse-wordmark ${className}` : "muse-wordmark"}>
      <MuseMark size={size} />
      <div className="muse-wordmark-copy">
        <strong>Muse</strong>
        <span>{tagline}</span>
      </div>
    </div>
  );
}
