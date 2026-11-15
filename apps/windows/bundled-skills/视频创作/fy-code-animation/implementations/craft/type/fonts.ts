// Adapted from renoise-ai/renoise-skills; see LICENSES/renoise-MIT.txt and implementations/craft/README.md.
import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";

/** One face from public/fonts/fonts.json (written by scripts/fonts.py fetch). */
export type Face = { id: string; family: string; file: string; weight: string; style: string; stretch: string | null; axes: Record<string, [number, number, number]>; license: string };

const FALLBACK: Record<string, string> = {
  latin: '-apple-system, "Helvetica Neue", Arial, sans-serif',
  "zh-Hans": '"PingFang SC", "Noto Sans SC", sans-serif',
  ja: '"Hiragino Sans", "Noto Sans JP", sans-serif',
};

/**
 * Registers every face in public/fonts/fonts.json (or only `ids`) and holds the render until they are loaded.
 * Declares weight/stretch ranges exactly as the files provide, so Chrome never fakes a bold or an italic.
 */
export const useFontManifest = (ids?: string[]) => {
  const [handle] = useState(() => delayRender("font manifest"));
  const [faces, setFaces] = useState<Face[] | null>(null);
  useEffect(() => {
    fetch(staticFile("fonts/fonts.json"))
      .then((r) => { if (!r.ok) throw new Error(`font manifest HTTP ${r.status}`); return r.json(); })
      .then(async (all: Face[]) => {
        const list = ids ? all.filter((f) => ids.includes(f.id)) : all;
        if (ids?.some(id=>!list.some(f=>f.id===id))) throw new Error("requested font ID missing");
        await Promise.all(
          list.map((f) =>
            new FontFace(f.family, `url(${staticFile(f.file)})`, { weight: f.weight, style: f.style, ...(f.stretch ? { stretch: f.stretch } : {}) })
              .load()
              .then((ff) => document.fonts.add(ff)),
          ),
        );
        await document.fonts.ready;
        setFaces(list);
        continueRender(handle);
      })
      .catch((e) => cancelRender(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);
  return faces;
};

/** CSS font-family for a family name with a sensible fallback for its script. */
export const fam = (family: string, script: "latin" | "zh-Hans" | "ja" = "latin") => `"${family}", ${FALLBACK[script]}`;
