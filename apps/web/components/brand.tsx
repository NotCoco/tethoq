import Image from "next/image";
import Link from "next/link";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand" aria-label="Tethoq home">
      <span className="brand-mark" aria-hidden="true">
        <Image src="/tethoq-mark.png" alt="" width={32} height={32} />
      </span>
      {!compact && <span>Tethoq</span>}
    </Link>
  );
}
