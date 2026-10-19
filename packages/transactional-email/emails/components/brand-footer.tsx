import { Hr, Section, Text } from "@react-email/components";

export function BrandFooter() {
  return (
    <>
      <Hr className="m-0 border-gray-200" />
      <Section className="bg-[#FDFDFD] px-8 py-4">
        <Text className="m-0 text-[11px] text-gray-500">
          Sent via <span className="font-semibold text-gray-700">Cue</span>
        </Text>
      </Section>
    </>
  );
}
