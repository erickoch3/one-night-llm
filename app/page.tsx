import type { Metadata } from "next";
import { GameApp } from "./game-app";

export const metadata: Metadata = {
  title: "One Night — A village of voices",
  description:
    "A local, Codex-powered social deduction game where one human faces a village of AI players.",
};

export default function Home() {
  return <GameApp />;
}
