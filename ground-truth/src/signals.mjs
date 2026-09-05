// Signal taxonomy. Every signal the engine stores is one of these categories.
// Rule from the vision: if a signal does not change who we contact, what we say,
// or when we say it, the engine should not be collecting it. Each category below
// is tied to a dimension of a score, so it always moves a decision.

export const OPERATOR_DIMENSIONS = {
  adoption: {
    label: "Adoption",
    help: "Where the operator sits on the arc: untouched -> experimenting -> deploying -> compounding.",
    categories: {
      ai_pilot: { label: "AI pilot / experiment announced", strength: 2 },
      ai_deployment: { label: "AI in production workflow", strength: 4 },
      ai_vendor: { label: "Named AI / automation vendor relationship", strength: 3 },
      ai_hire: { label: "AI / data / automation hire", strength: 3 },
      ai_results: { label: "Reported results from AI (cost, cycle time, margin)", strength: 5 },
      modernization: { label: "Systems modernization underway (ERP, TMS, WMS, claims platform)", strength: 2 },
      ai_public_stance: { label: "Leadership speaks publicly about AI", strength: 2 },
      legacy_stack: { label: "Legacy / manual stack noted", strength: 2, direction: -1 },
    },
  },
  pressure: {
    label: "Pressure",
    help: "How much the business is being squeezed: labor, margin, competition, owners.",
    categories: {
      labor_gap: { label: "Labor gap / hiring difficulty", strength: 3 },
      margin_compression: { label: "Margin compression / pricing pressure", strength: 3 },
      competitive_displacement: { label: "Competitor deploying AI / losing share", strength: 4 },
      regulatory_load: { label: "Compliance / documentation burden", strength: 2 },
      volume_spike: { label: "Volume growth outpacing headcount", strength: 3 },
      pe_standardization: { label: "PE-backed / acquisition-driven standardization", strength: 3 },
      exit_window: { label: "Owner approaching exit / succession", strength: 4 },
      manual_workflow: { label: "Manual, paper-heavy workflows", strength: 2 },
    },
  },
  openness: {
    label: "Openness",
    help: "What the company does before it knows it is a buyer.",
    categories: {
      tech_job_posting: { label: "Technology / data / automation job posting", strength: 3 },
      leadership_change: { label: "New CEO / COO / CIO / transformation leader", strength: 3 },
      transformation_seat: { label: "Transformation / digital seat exists", strength: 2 },
      capacity_announcement: { label: "New facility, fleet, or capacity announcement", strength: 2 },
      acquisition: { label: "Acquisition / merger (integration work ahead)", strength: 3 },
      capital_event: { label: "Recap, new sponsor, or financing", strength: 3 },
      conference_or_press: { label: "Public statements on efficiency / technology", strength: 1 },
      inbound_or_referral: { label: "Inbound interest or referral mention", strength: 4 },
      declined: { label: "Declined / not interested", strength: 3, direction: -1 },
    },
  },
};

export const SPONSOR_DIMENSIONS = {
  posture: {
    label: "AI posture",
    help: "Visible AI activity and value-creation language across the platform.",
    categories: {
      ai_value_creation_language: { label: "AI in value-creation / 100-day plan language", strength: 3 },
      portfolio_ai_activity: { label: "Portfolio company AI deployment", strength: 3 },
      ai_thesis_public: { label: "Partners speak publicly on AI", strength: 2 },
      ai_vendor_program: { label: "Portfolio-wide vendor / preferred-vendor program", strength: 4 },
      no_ai_story: { label: "Explicitly no AI story / skeptical", strength: 2, direction: -1 },
    },
  },
  mandate: {
    label: "Operating mandate",
    help: "Operating-partner hires and mandates that make the door real.",
    categories: {
      op_partner_hire: { label: "Operating partner / value-creation hire", strength: 3 },
      ai_op_partner: { label: "Operating partner with explicit AI / digital mandate", strength: 5 },
      value_creation_team: { label: "Dedicated value-creation team", strength: 2 },
    },
  },
  vintage: {
    label: "Fund / exit pressure",
    help: "Fundraising and hold-period signals that make a sponsor a motivated seller or buyer.",
    categories: {
      fund_close: { label: "New fund closed", strength: 3, direction: -1 },
      fundraising_stalled: { label: "Fundraise stalled / extended", strength: 4 },
      continuation_vehicle: { label: "Continuation vehicle / secondary", strength: 4 },
      long_hold: { label: "Asset held 5+ years", strength: 3 },
      exit_attempt: { label: "Failed or pulled sale process", strength: 5 },
      exit_completed: { label: "Portfolio exit completed", strength: 2, direction: -1 },
    },
  },
  activity: {
    label: "Deal activity",
    help: "New platforms and add-ons in our verticals.",
    categories: {
      new_platform: { label: "New platform in our verticals", strength: 3 },
      add_on: { label: "Add-on acquisition (integration ahead)", strength: 2 },
      leadership_change_portco: { label: "Portco leadership change", strength: 2 },
    },
  },
};

export function dimensionsFor(entityType) {
  return entityType === "operator" ? OPERATOR_DIMENSIONS : SPONSOR_DIMENSIONS;
}

export function categoryInfo(entityType, dimension, category) {
  return dimensionsFor(entityType)[dimension]?.categories?.[category] ?? null;
}

export function validateSignal(entityType, s) {
  const dims = dimensionsFor(entityType);
  if (!dims[s.dimension]) throw new Error(`unknown dimension '${s.dimension}' for ${entityType}`);
  if (!dims[s.dimension].categories[s.category]) throw new Error(`unknown category '${s.category}' in ${s.dimension}`);
  if (!s.title) throw new Error("signal needs a title");
  const strength = Number(s.strength ?? dims[s.dimension].categories[s.category].strength ?? 2);
  if (!(strength >= 1 && strength <= 5)) throw new Error("strength must be 1-5");
  const confidence = (s.confidence || "M").toUpperCase();
  if (!["H", "M", "L"].includes(confidence)) throw new Error("confidence must be H, M or L");
  const direction = s.direction != null ? Number(s.direction) : (dims[s.dimension].categories[s.category].direction ?? 1);
  return { ...s, strength, confidence, direction: direction < 0 ? -1 : 1 };
}

// Flat list for the UI / agent prompt.
export function taxonomyList(entityType) {
  const out = [];
  for (const [dim, d] of Object.entries(dimensionsFor(entityType))) {
    for (const [cat, c] of Object.entries(d.categories)) {
      out.push({ dimension: dim, dimension_label: d.label, category: cat, label: c.label, default_strength: c.strength, direction: c.direction ?? 1 });
    }
  }
  return out;
}
