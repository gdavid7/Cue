import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-foreground text-background hover:bg-foreground/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-red-500 text-white hover:bg-red-500/80 dark:bg-red-900 dark:hover:bg-red-900/80",
        outline: "text-foreground",
        green:
          "border-transparent bg-green-100 hover:bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-300 dark:hover:bg-green-950",
        red: "border-transparent bg-red-100 hover:bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-950",
        success:
          "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-400",
        warning:
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400",
        info: "border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-400",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
      size: {
        default: "",
        sm: "gap-1.5 rounded-md px-2 text-xs font-medium",
        xs: "gap-1 rounded-md px-1.5 text-[10px] font-medium",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
