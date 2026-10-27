import { route, checkPassword, setSession, isLoggedIn } from "./_lib.js";

// GET: is this browser logged in?  POST {password}: log in.  DELETE: log out.
export default route(["GET", "POST", "DELETE"], async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ ok: isLoggedIn(req) });
  if (req.method === "DELETE") { setSession(res, false); return res.status(200).json({ ok: true }); }
  if (!checkPassword(req.json.password)) {
    await new Promise((r) => setTimeout(r, 600)); // slows down guessing
    return res.status(401).json({ error: "Mot de passe incorrect." });
  }
  setSession(res, true);
  res.status(200).json({ ok: true });
}, { auth: false });
