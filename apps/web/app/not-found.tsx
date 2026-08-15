import Link from "next/link";
import { Brand } from "@/components/brand";

export default function NotFound() {
  return <main className="center-page"><Brand /><p className="eyebrow">404</p><h1>That page isn’t here.</h1><p>The task may have moved, but home is one click away.</p><Link className="button button-primary" href="/">Return home</Link></main>;
}
