import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Klip Analista",
  description: "Atendimentos da KlipFlowi, com transcrição dos áudios.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body className="min-h-screen antialiased">
        <header className="border-b border-slate-200 bg-white">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 text-sm">
            <Link href="/atendimentos" className="font-semibold text-marca-600">
              Klip Analista
            </Link>
            <Link href="/atendimentos" className="text-slate-600 hover:text-slate-900">
              Atendimentos
            </Link>
            <Link href="/configuracoes" className="text-slate-600 hover:text-slate-900">
              Configurações
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
