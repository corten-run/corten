import { Link } from "@tanstack/react-router";

/** Corten's 404 page. */
export function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p>There is no card at this address.</p>
      <p><Link to="/">Go to popular items</Link></p>
    </>
  );
}
