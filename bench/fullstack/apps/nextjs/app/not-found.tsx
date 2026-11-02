import Link from "next/link";

export const metadata = { title: "Not found | Card Market" };

export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p>There is no card at this address.</p>
      <p><Link href="/">Go to popular items</Link></p>
    </>
  );
}
