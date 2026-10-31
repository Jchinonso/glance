// Loaded before app.js as a plain script (looksLikeResume becomes a global).
// Custom instructions are compressed when saved, which rewrites wording, so a
// resume pasted there loses the exact phrasing the Resume field keeps.
const RESUME_HEADING = /^\s*(?:work\s+)?(?:experience|education|skills|projects|employment(?:\s+history)?|certifications|professional\s+summary|summary)\s*:?\s*$/gim;
const DATE_RANGE = /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2}\s*(?:-|–|—|to)\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:(?:19|20)\d{2}|present|now|current)\b/gi;
const ACHIEVEMENT_LINE = /^\s*(?:[-•*▪]\s*)?(?:led|built|managed|developed|designed|implemented|launched|owned|delivered|improved|reduced|increased)\b/gim;

// True when the text reads like a resume: job date ranges plus resume section
// headings or achievement bullets.
function looksLikeResume(text) {
  if (!text || text.length < 300) return false;
  const dates = (text.match(DATE_RANGE) || []).length;
  const headings = (text.match(RESUME_HEADING) || []).length;
  const achievements = (text.match(ACHIEVEMENT_LINE) || []).length;
  return dates >= 2 && headings + Math.min(achievements, 3) >= 2;
}
