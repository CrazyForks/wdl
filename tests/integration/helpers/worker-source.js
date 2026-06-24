/** @param {string} body */
export function workerFetchCallerSource(body) {
  return `
export default {
  async fetch(req, env) {
    try {
${body}
    } catch (err) {
      return new Response(JSON.stringify({ err: err.message }), { status: 500 });
    }
  },
};
`;
}
