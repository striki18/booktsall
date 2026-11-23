import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zevidt — money, made clearer",
  description: "One clear place to collect documents, understand what is missing, and prepare reliable finance packages.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
