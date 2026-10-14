import { cn } from "@/utils";

interface NoticeProps {
  children: React.ReactNode;
  className?: string;
  variant?: "info" | "warning" | "success" | "error";
}

const variantStyles = {
  info: "text-blue-600 bg-blue-50 border-blue-100 dark:text-blue-300 dark:bg-blue-950/60 dark:border-blue-900",
  warning:
    "text-amber-600 bg-amber-50 border-amber-100 dark:text-amber-300 dark:bg-amber-950/60 dark:border-amber-900",
  success:
    "text-green-600 bg-green-50 border-green-100 dark:text-green-300 dark:bg-green-950/60 dark:border-green-900",
  error:
    "text-red-600 bg-red-50 border-red-100 dark:text-red-300 dark:bg-red-950/60 dark:border-red-900",
};

export function Notice({ children, variant = "info", className }: NoticeProps) {
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm",
        variantStyles[variant],
        className,
      )}
    >
      {children}
    </div>
  );
}
