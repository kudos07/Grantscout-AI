export type OpportunityType = "grant" | "fellowship" | "scholarship" | "startup_credits" | "other";

export type Evidence = { url: string; quote: string };

export type Opportunity = {
  rank?: number;
  name: string;
  type: OpportunityType;
  official_link: string;
  application_link?: string | null;
  deadline?: string | null;
  amount?: string | null;
  location?: string | null;
  requirements?: string[];
  eligibility_score: number; // 0..1
  eligibility_reason?: string;
  evidence?: Evidence[];
};

export type GrantScoutReport = {
  opportunities: Opportunity[];
  checklist: string[];
  drafts: Record<string, string>;
  notes: string[];
};

