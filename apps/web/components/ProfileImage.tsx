import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/utils/email";

export function ProfileImage({
  image,
  label = "",
  size = 24,
  className,
}: {
  image: string | null;
  label: string;
  size?: number;
  className?: string;
}) {
  return (
    <Avatar className={className}>
      <AvatarImage src={image || undefined} width={size} height={size} />
      <AvatarFallback className="text-[0.625rem] font-medium">
        {getInitials(label)}
      </AvatarFallback>
    </Avatar>
  );
}
