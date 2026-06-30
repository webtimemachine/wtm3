// Permanent redirect: webtimemachine.io (+ www) -> webtm.io, preserving path + query.
export default {
  fetch(req: Request): Response {
    const url = new URL(req.url);
    return Response.redirect(`https://webtm.io${url.pathname}${url.search}`, 301);
  },
};
