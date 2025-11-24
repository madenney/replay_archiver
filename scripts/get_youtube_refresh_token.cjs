
// get_youtube_refresh_token.js
const { google } = require("googleapis");
require("dotenv").config();

const SCOPES = [
  // allows uploads:
  "https://www.googleapis.com/auth/youtube.upload",
];

async function main() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in your .env first.");
    process.exit(1);
  }

  const redirectUri = "http://localhost:3000/oauth2callback"; // dummy for desktop
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",   // critical: gets you a refresh_token
    prompt: "consent",        // force Google to actually issue one
    scope: SCOPES,
  });

  console.log("1. Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\n2. Log in as the channel owner and approve access.");
  console.log("3. Google will show you a code. Paste it here.\n");

  process.stdout.write("Code: ");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (code) => {
    code = code.trim();
    try {
      const { tokens } = await oauth2Client.getToken(code);
      console.log("\nTokens from Google:\n", tokens);

      if (tokens.refresh_token) {
        console.log("\n✅ Use this as YOUTUBE_REFRESH_TOKEN:");
        console.log(tokens.refresh_token);
      } else {
        console.log("\n❌ No refresh_token returned.");
        console.log("Make sure access_type=offline and prompt=consent are set.");
      }
      process.exit(0);
    } catch (err) {
      console.error("\nError exchanging code for tokens:\n", err.response?.data || err);
      process.exit(1);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
