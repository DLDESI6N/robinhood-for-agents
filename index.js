import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveDailyLog(content, phaseName) {
  try {
    const logsDir = "./reports"; 
    await fs.mkdir(logsDir, { recursive: true });
    
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    
    // Grabbing local time just for the filename string
    const timeStr = `${now.getHours()}-${now.getMinutes()}`;
    const fileName = `${logsDir}/briefing-${phaseName}-${dateStr}_${timeStr}.md`;
    
    await fs.writeFile(fileName, content); 
    console.log(`\nReport successfully saved to: ${fileName}`);
  } catch (error) {
    console.error("Failed to save daily log:", error);
  }
}

function getTradingPhase() {
  // Force time evaluation in Eastern Time (America/New_York) to avoid UTC server drift
  const now = new Date();
  const etString = now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
  const [hoursStr, minutesStr] = etString.split(":");
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);

  // Phase 1: ~7:40 AM ET (Cron should trigger at 7:40)
  if (hours === 7 && minutes >= 30 && minutes <= 59) return "PHASE_1";
  
  // Phase 2: ~9:20 AM ET (Cron should trigger at 9:20)
  if (hours === 9 && minutes >= 15 && minutes <= 45) return "PHASE_2";
  
  // Phase 3: ~10:15 AM ET (Cron should trigger at 10:15)
  if (hours === 10 && minutes >= 10 && minutes <= 45) return "PHASE_3";
  
  // Ad-hoc Intraday Runs: 11:00 AM ET or later defaults to Phase 1 logic
  if (hours >= 11) return "PHASE_1";
  
  return "UNKNOWN";
}

async function main() {
  const phase = getTradingPhase();
  
  if (phase === "UNKNOWN") {
    console.log("Current ET time does not match any trading phases (7:40, 9:20, 10:15). Exiting.");
    process.exit(0);
  }

  console.log(`=== INITIATING ${phase} ===`);
  console.log("Connecting to MCP Servers (Robinhood & Yahoo Finance)...");

  const rhTransport = new StdioClientTransport({
    command: "bun",
    args: ["bin/robinhood-for-agents.ts"], 
  });
  const rhClient = new Client(
    { name: "robinhood-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await rhClient.connect(rhTransport);

  const yfTransport = new StdioClientTransport({
    command: "bunx",
    args: ["yahoo-finance-mcp"], 
  });
  const yfClient = new Client(
    { name: "yahoo-finance-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await yfClient.connect(yfTransport);

  console.log("Connected to servers! Fetching tool registries...");

  const rhToolsList = await rhClient.listTools();
  
  // Added get_open_orders, cancel_order, and a catch-all "order" to ensure order management tools are available
  const allowedRhToolNames = ["get_account", "get_portfolio", "get_positions", "place_stock_order", "get_open_orders", "cancel_order", "order"];
  const filteredRhTools = rhToolsList.tools.filter(tool => 
    allowedRhToolNames.some(name => tool.name.includes(name))
  );

  const yfToolsList = await yfClient.listTools();
  const allMcpTools = [...filteredRhTools, ...yfToolsList.tools];
  
  const mcpGeminiTools = allMcpTools.map(tool => {
    const formattedProperties = {};
    if (tool.inputSchema?.properties) {
      for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
        formattedProperties[key] = {
          type: mapTypeToGemini(prop.type),
          description: prop.description || "",
        };
      }
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: formattedProperties,
        required: tool.inputSchema.required || []
      }
    };
  });

  const ai = new GoogleGenAI({});
  const modelName = "gemini-3.1-pro-preview"; 

  // Base rules that apply to all phases
  const baseRules = `
    You are the "Silly Stock Selector," an autonomous algorithmic trading assistant.
    CRITICAL RULE: NEVER use Market orders. You MUST ONLY use LIMIT orders that are precise to the current live price to prevent slippage.
    CRITICAL RULE: Do NOT ask for human confirmation. Execute autonomously.
    DATA GATHERING: Use Yahoo tools (one ticker at a time) or googleSearch as fallback. Get Robinhood account ID before trading.
  `;

  let systemInstruction = "";
  let initialPrompt = "";

  // Assign phase-specific logic
  if (phase === "PHASE_1") {
    // Re-evaluate ET hours just for the prompt context
    const etString = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
    const isLateRun = parseInt(etString.split(":")[0], 10) >= 11;
    
    const timeContext = isLateRun 
      ? "CURRENT TIME PHASE: Intraday/Late Run (11:00 AM+ ET). OBJECTIVE: Find intraday setups, calculate allocations, and execute BUY Limit orders."
      : "CURRENT TIME PHASE: 7:40 AM ET - Daily Setup. OBJECTIVE: Find pre-market setups, calculate allocations, and execute BUY Limit orders.";

    systemInstruction = baseRules + `
      ${timeContext}
      
      RULES:
      1. Market Sentiment: Check SPY/QQQ. If down >0.36%, trigger Bear Market Protocol (max 45% in inverse ETF like SH, strict long setups only).
      2. Max Sizing: Total deployed capital never exceeds 98%.
      3. Max Spread: If Bid-Ask spread > $0.15 or 0.25% of price, ABORT trade.
      4. Limit Price Calculation: Ask + $0.05, but NEVER exceed market price by more than 0.5%.
      5. Fractional Shares: List any fractionals the user should buy manually in the report, do NOT execute them via API.
      6. EXTENDED HOURS EXECUTION: If trading before 9:30 AM ET, you MUST explicitly include the parameter to execute during extended hours (e.g. extended_hours: true) so the order fills immediately instead of queuing for open.

      OUTPUT REPORT FORMAT:
      ## 📅 Setup Plan (Phase 1)
      **Buying Power:** $X | **Invested:** $X
      **Sentiment:** [Overview]
      ### Strategy Executed: [Ticker]
      * **Entry:** [Limit price and share count]
      ### Manual Fractional Shares Required:
      * [List any fractional share setups the user needs to buy manually]
    `;
    
    initialPrompt = isLateRun 
      ? "Begin intraday market analysis. Analyze market, find setups, calculate limits, execute BUY limit orders, and output the report."
      : "Begin 7:40 AM daily market analysis. Analyze market, find stocks, calculate limits, execute BUY limit orders, and output the report.";
  
  } else if (phase === "PHASE_2") {
    systemInstruction = baseRules + `
      CURRENT TIME PHASE: 9:20 AM ET - Position Assessment.
      OBJECTIVE: Retrieve current positions, evaluate P&L, and execute exit Limit orders if thresholds are met.
      
      RULES:
      1. Call get_positions to view currently held stocks and their average buy price.
      2. Check live prices using Yahoo Finance or googleSearch.
      3. CRITICAL EVALUATION & CANCELLATION:
         - If a position is at a 1.5% LOSS or worse: Execute a Sell Limit order immediately to stop the loss.
         - If a position is at a 2.5% GAIN or better: Execute a Sell Limit order immediately to secure profit.
         - LOCKED SHARES PREVENTION: Before placing ANY sell order, you MUST check if there is an existing open order for that ticker. If an open order exists, you MUST cancel it first. You cannot place a new sell order if shares are locked in an existing bracket.
         - If a position is between -1.49% and +2.49%, do nothing and hold.
      
      OUTPUT REPORT FORMAT:
      ## 📅 9:20 AM Assessment Report
      * List positions held.
      * Note which were sold (loss cut / profit taken) and the limit prices used. Mention if you had to cancel an open order first.
      * Note which are being held.
    `;
    initialPrompt = "Begin 9:20 AM assessment. Pull my current positions, check their live prices. If any position is down 1.5%+ or up 2.5%+, cancel any existing open orders for it and execute a new limit sell order.";
  
  } else if (phase === "PHASE_3") {
    systemInstruction = baseRules + `
      CURRENT TIME PHASE: 10:15 AM ET - Daily Liquidation.
      OBJECTIVE: Close out the day's trades to mitigate overnight risk.
      
      RULES:
      1. Call get_positions to view currently held stocks.
      2. Check live prices for each held ticker.
      3. LOCKED SHARES PREVENTION: Before placing ANY sell order, you MUST check for and CANCEL any existing open sell orders for that ticker.
      4. LIQUIDATION: You MUST Sell all positions using precise limit orders, UNLESS the current live price is within 0.5% of the original average purchase price.
      5. If the price has not moved more than 0.5% in either direction, DO NOT sell it (Hold). 
      
      OUTPUT REPORT FORMAT:
      ## 📅 10:15 AM Liquidation Report
      * List all positions liquidated and the limit prices used. Mention cancelled orders.
      * List any positions retained because they were within the 0.5% flat zone.
    `;
    initialPrompt = "Begin 10:15 AM liquidation. Pull current positions, check live prices. Cancel any existing open orders for your positions, then sell them all via limit orders UNLESS they are within 0.5% of the original purchase price.";
  }

  let chat = ai.chats.create({
    model: modelName,
    config: {
      tools: [
        { functionDeclarations: mcpGeminiTools },
        { googleSearch: {} } 
      ],
      toolConfig: { includeServerSideToolInvocations: true },
      systemInstruction: systemInstruction,
      temperature: 0.1 
    }
  });

  console.log(`Executing AI chat loop for ${phase}...`);
  let response = await chat.sendMessage({ message: initialPrompt });

  // Core Tool Execution Loop
  response = await processAiLoop(chat, response, filteredRhTools, yfToolsList, rhClient, yfClient);

  let finalLogContent = response.text;

  // Phase 1 has a unique two-step process: Buy -> Wait 10 mins -> Set Sell Limits
  if (phase === "PHASE_1" && !response.text.includes("NO TRADE")) {
    console.log("\n--------------------------------------------------");
    console.log("Phase 1 buys placed. Waiting 10 minutes (600,000ms) to stage bracket limits...");
    console.log("--------------------------------------------------");

    // Wait exactly 10 minutes before placing the bracket sell limits
    await sleep(600000); 

    console.log("Resuming: Staging exit bracket limit orders...");
    
    let followUpResponse = await chat.sendMessage({
      message: "10 minutes have passed. Check filled shares via get_positions, check current prices, and place Take-Profit Limit sell orders at approximately a +2% gain (or a safe AI-determined gain based on current resistance). Remember to use extended hours if it is still before 9:30 AM ET."
    });

    followUpResponse = await processAiLoop(chat, followUpResponse, filteredRhTools, yfToolsList, rhClient, yfClient);
    
    finalLogContent += "\n\n### Phase 1 (Part B): Limit Exits Staged\n" + followUpResponse.text;
    console.log(followUpResponse.text);
  } else {
    console.log("\n--------------------------------------------------");
    console.log(response.text);
    console.log("--------------------------------------------------");
  }

  await saveDailyLog(finalLogContent, phase);

  await rhClient.close();
  await yfClient.close();
  console.log(`=== ${phase} COMPLETE ===`);
}

// Helper function to handle the function calling recursion loop
async function processAiLoop(chat, response, filteredRhTools, yfToolsList, rhClient, yfClient) {
  let currentResponse = response;
  
  while (currentResponse.functionCalls && currentResponse.functionCalls.length > 0) {
    let toolResponses = [];

    for (const call of currentResponse.functionCalls) {
      console.log(`\nExecuting tool: ${call.name} with arguments:`, JSON.stringify(call.args));
      
      let toolResult;
      let toolExecuted = false;

      try {
        if (filteredRhTools.some(t => t.name === call.name)) {
          toolResult = await rhClient.callTool({ name: call.name, arguments: call.args });
          toolExecuted = true;
        } else if (yfToolsList.tools.some(t => t.name === call.name)) {
          toolResult = await yfClient.callTool({ name: call.name, arguments: call.args });
          toolExecuted = true;
        }

        if (toolExecuted) {
          toolResponses.push({
            functionResponse: {
              name: call.name,
              response: { result: toolResult }
            }
          });
        }
      } catch (error) {
        console.error(`\n[!] Error executing ${call.name}:`, error.message);
        toolResponses.push({
          functionResponse: {
            name: call.name,
            response: { 
              error: `Tool failed: ${error.message}. Use googleSearch if Yahoo failed to find current/historical data.` 
            }
          }
        });
      }
    }

    if (toolResponses.length > 0) {
      currentResponse = await chat.sendMessage({ message: toolResponses });
    } else {
      currentResponse = await chat.sendMessage({ message: "Continue." });
    }
  }
  return currentResponse;
}

function mapTypeToGemini(jsonType) {
  switch (jsonType?.toLowerCase()) {
    case 'string': return Type.STRING;
    case 'number': return Type.NUMBER;
    case 'integer': return Type.INTEGER;
    case 'boolean': return Type.BOOLEAN;
    case 'array': return Type.ARRAY;
    case 'object': return Type.OBJECT;
    default: return Type.STRING;
  }
}

main().catch(console.error);