import * as React from "react";

import { cn } from "@/utils";

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { size?: "default" | "sm" }
>(({ className, size = "default", ...props }, ref) => (
  <div
    ref={ref}
    data-size={size}
    className={cn(
      "group/card rounded-lg border bg-card text-card-foreground shadow-sm",
      className,
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex flex-col space-y-1.5 p-6 group-data-[size=sm]/card:p-4",
      className,
    )}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      "text-2xl font-semibold leading-none tracking-tight group-data-[size=sm]/card:text-base",
      className,
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "p-6 pt-0 group-data-[size=sm]/card:p-4 group-data-[size=sm]/card:pt-0",
      className,
    )}
    {...props}
  />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex items-center p-6 pt-0 group-data-[size=sm]/card:p-4 group-data-[size=sm]/card:pt-0",
      className,
    )}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

const CardBasic = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg border bg-card p-6 text-card-foreground shadow-sm",
      className,
    )}
    {...props}
  />
));
CardBasic.displayName = "CardBasic";

const ActionCard = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    icon?: React.ReactNode;
    title: string;
    description: string | React.ReactNode;
    action?: React.ReactNode;
    variant?: "green" | "blue" | "destructive";
  }
>(
  (
    {
      className,
      icon,
      title,
      description,
      action,
      variant = "green",
      ...props
    },
    ref,
  ) => {
    const iconColor = {
      green: "text-green-600 dark:text-green-400",
      blue: "text-blue-600 dark:text-blue-400",
      destructive: "text-red-600 dark:text-red-400",
    }[variant];

    return (
      <Card
        ref={ref}
        className={cn(
          "max-w-2xl",
          variant === "destructive" && "border-destructive/40",
          className,
        )}
        {...props}
      >
        <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            {icon && (
              <div className={cn("mt-0.5 flex-shrink-0", iconColor)}>
                {icon}
              </div>
            )}
            <div>
              <h3 className="font-title text-lg">{title}</h3>
              <div className="mt-1 text-sm text-muted-foreground">
                {description}
              </div>
            </div>
          </div>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
      </Card>
    );
  },
);
ActionCard.displayName = "ActionCard";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  CardBasic,
  ActionCard,
};
