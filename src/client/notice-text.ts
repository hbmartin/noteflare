/** Finish an explanation before appending independent client guidance. */
export const noticeSentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** Known permission limitations; callers retain their own status and fallback policy. */
