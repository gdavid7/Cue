import { ThemeProvider } from "@/components/theme-provider";

// The way into the app follows the theme people picked inside it, as the app
// does (light until they choose).
export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light">
      {children}
    </ThemeProvider>
  );
}
