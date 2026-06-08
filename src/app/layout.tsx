import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GrantScout AI",
  description: "Grant discovery + eligibility matching.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <div className="mx-auto w-full max-w-[1800px] px-4 py-4 lg:px-5">{children}</div>
      </body>
    </html>
  );
}
