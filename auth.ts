import { robinhood_browser_login } from "robinhood-for-agents";

async function login() {
  try {
    console.log("Requesting Robinhood login...");
    await robinhood_browser_login();
    console.log("Authentication cached successfully.");
  } catch (error: any) {
    if (error.name === 'UrlElicitationRequiredError' || error.elicitations) {
        console.log("\nAction Required! Please click the link below to authenticate:");
        console.log(JSON.stringify(error.elicitations, null, 2));
    } else {
        console.error("\nAn unexpected error occurred:", error);
    }
  }
}

login();