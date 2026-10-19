/**
 * A Deep Clean thread as Redis holds and publishes it: ids, status and the
 * date only. Who sent it and what it says stay out of Redis (RD-3); the
 * browser looks those up for the rows it shows.
 */
export type CleanThread = {
  emailAccountId: string;
  threadId: string;
  jobId: string;
  status: "processing" | "applying" | "completed";
  createdAt: string;
  date: Date;

  archive?: boolean;
  label?: string;
  undone?: boolean;
};
