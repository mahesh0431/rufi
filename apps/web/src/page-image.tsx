// A page of a person's document as the AI sees it, from the core's page
// address: on the document's page, and in a step of Activity that read it.
import { useEffect, useState } from "react";
import { fetchFile } from "./api.ts";
import { Problem } from "./ui.tsx";

/** A page's image, fetched with the tab's proof and shown from a blob. */
export function PageImage({
  path,
  alt,
  className,
}: {
  path: string;
  alt: string;
  className: string;
}) {
  const [shown, setShown] = useState<{ url?: string; error?: Error }>({});
  useEffect(() => {
    let url: string | undefined;
    let gone = false;
    fetchFile(path).then(
      (blob) => {
        url = URL.createObjectURL(blob);
        if (gone) URL.revokeObjectURL(url);
        else setShown({ url });
      },
      (error: unknown) => {
        if (!gone) setShown({ error: error as Error });
      },
    );
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  if (shown.error) return <Problem error={shown.error} />;
  if (!shown.url) {
    return (
      <p role="status" className="m-auto text-muted">
        Preparing the page…
      </p>
    );
  }
  return <img src={shown.url} alt={alt} className={className} />;
}
