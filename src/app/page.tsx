"use client";

import { ReleaseNotes } from "@/components/release-notes";
import { useCompletion } from "ai/react";

export default function Home() {
  const { complete, completion, error } = useCompletion({
    api: "/api/generate",
  });
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-24">
      <ReleaseNotes
        onSubmit={(startDate, endDate) =>
          complete("", {
            body: { startDate, endDate },
          })
        }
        notes={completion}
      />
      {error && <div className="text-red">{`${error}`}</div>}
    </main>
  );
}
