// A page of a person's document as the AI sees it, from the core's page
// address: on the document's page, and in a step of Activity that read it.
// It is one of the person's document reads, so a change to their documents
// (a delete, a sort) reads it again: a deleted one says so.
import { useQuery } from "@tanstack/react-query";
import { fetchFile } from "./api.ts";
import { Problem } from "./ui.tsx";

/** A file as a data: address, which an image shows with nothing to free. */
const dataAddress = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("The page couldn't be read."));
    };
    reader.readAsDataURL(file);
  });

/** A page's image, fetched with the tab's proof. */
export function PageImage({
  personId,
  path,
  alt,
  className,
}: {
  personId: string;
  path: string;
  alt: string;
  className: string;
}) {
  const page = useQuery({
    queryKey: ["documents", personId, "page", path],
    queryFn: async () => dataAddress(await fetchFile(path)),
    // A page's bytes aren't kept once nothing shows them.
    gcTime: 0,
  });
  if (page.error) return <Problem error={page.error} />;
  if (!page.data) {
    return (
      <p role="status" className="m-auto text-muted">
        Preparing the page…
      </p>
    );
  }
  return <img src={page.data} alt={alt} className={className} />;
}
