import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Flowi Copilot Comercial",
  description:
    "Seu consultor de CRM e inteligência comercial. A Flowi IA analisa os atendimentos, " +
    "identifica oportunidades e orienta sua equipe sobre o próximo passo para transformar " +
    "conversas em vendas.",
  // O módulo é interno e roda dentro da KlipFlowi: não deve ser indexado.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#2145e3",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body className="min-h-screen bg-surface-page antialiased">{children}</body>
    </html>
  );
}
