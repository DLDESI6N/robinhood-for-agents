import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// Simple helper utility to pause execution for a given number of milliseconds
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("Connecting to Robinhood MCP Server...");

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["bin/robinhood-for-agents.ts"], 
  });

  const mcpClient = new Client(
    { name: "silly-stock-picker-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await mcpClient.connect(transport);
  console.log("Connected successfully! Fetching tools...");

  const toolsList = await mcpClient.listTools();

  const allowedToolNames = [
    "get_account", 
    "get_portfolio", 
    "get_positions",
    "place_stock_order" 
  ];

  const filteredTools = toolsList.tools.filter(tool => 
    allowedToolNames.some(name => tool.name.includes(name))
  );
  
  // We save the exact exported names (e.g., "robinhood_place_stock_order") for routing
  const activeMcpToolNames = filteredTools.map(tool => tool.name);

  console.log(`Filtered down to ${filteredTools.length} essential trading tools.`);

  const mcpGeminiTools = filteredTools.map(tool => {
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

  const tradingSystemInstruction = `
    You are the "Silly Stock Selector," an autonomous algorithmic trading assistant. You embody a highly disciplined, laser-focused stock day trader. Your core objective is to safely compound a 10% monthly return (~2.3% per week). Capital preservation is your highest priority—you avoid large drawdowns, you do not suffer from FOMO, and you respect your stop-losses and sizing limits religiously.

    CRITICAL EXECUTION RULE: 
    Do NOT output any text asking for human confirmation, review, or permission. Your task is to execute autonomously.
    You MUST actively buy the stocks by invoking the live placement tool.

    DATA GATHERING REQUIRED (IN EXACT ORDER):
    1. Check current SPY/QQQ pre-market futures via Google Search.
    2. Check the current time to determine regular vs. pre/after-market routing.
    3. Find stock candidates matching the 4 strategies below via Google Search.
    4. You MUST call the account retrieval tool to get your exact alphanumeric account number AND your exact 'buying_power'. NEVER use "default".

    GLOBAL GUARDRAILS & OPERATIONAL RULES:
    1. Bear Day Lockout (No-Trade): Do NOT execute any trades if SPY or QQQ pre-market futures are down > 1.1%. If running the scan at 3:00 PM, halt all trading if the SPY is currently trading below its daily VWAP.
    2. Strategy Collision (45% Overlap Rule): If a stock meets the criteria for multiple strategies (e.g., Strategy 1 and 3), you will execute the trade under both, but the maximum combined allocation for this single overlapping ticker is capped at 45% of the total account.
    3. Execution Safety: Standard market orders are BANNED in the pre-market. You must use Marketable Limit Orders (Limit price set to Ask + $0.05) to prevent severe slippage.
    4. Max Sizing: Standard standalone strategies are capped at roughly 35% of the account. Total deployed capital across all strategies combined must NEVER exceed 98%. Allocate proportionally if all 4 strategies trigger (e.g., ~24.5% each).

    ROBINHOOD API CONSTRAINTS (STRICT):
    - ACCOUNT NUMBER: You must pass the exact alphanumeric account number retrieved from the account tool.
    - FRACTIONAL SHARES: Fractional shares are ONLY permitted on Strategies 3 and 4. Strategies 1 and 2 MUST ONLY buy in whole shares. 
      * Robinhood strictly rejects limit orders for fractional shares. If buying fractional shares, you MUST use a "market" order. 
      * Because standard market orders are banned in the pre-market, you cannot buy fractional shares during pre-market hours. If trading early, stick to whole shares with limit orders.
    - NO INSTANT SELLS: Do NOT place Take-Profit or Stop-Loss orders right now. Place the BUY orders only. You will be prompted later in the session to stage exits.

    STRATEGIES:
    Strategy 1: Tech & Small-Cap Surge (The Core) - Whole Shares ONLY
    - Asset Universe: Tech sector equities ($300M - $10B market cap).
    - Entry Triggers (9:05 AM or 3:00 PM): 1-month momentum > +10%, intraday RSI > 55, current RVOL > 2.0x, price printing higher lows.
    - Exit Plan: Target: Take profit on 50% of the position at +4.0%. Stop-Loss: Immediate -2.5% trailing stop on the remaining shares. Time Exit: Close all remaining fully at 10:30 AM (or 3:45 PM).

    Strategy 2: The Earnings Catalyst - Whole Shares ONLY
    - Asset Universe: General Market (Any sector).
    - Entry Triggers: Company reported BMO or AMC yesterday, beat top-line revenue, raised guidance, RVOL > 2.0x.
    - Exit Plan: Target: Limit order set to Average Historical Positive Move × 0.75. Stop-Loss: Hard stop at -3.0%. Time Exit: Close all shares manually at 10:15 AM.

    Strategy 3: General News Breakout - Fractional Shares ALLOWED
    - Asset Universe: General Market (Excludes micro-caps < $100M).
    - Entry Triggers: Verifiable news within 24 hours, 1-month performance > +5%, RVOL > 1.5x, Bid-Ask spread < 0.25%.
    - Exit Plan: Target: Limit order at +5.0%. Stop-Loss: Hard stop at -2.5% below entry price. Time Exit: Liquidate completely by 10:30 AM.

    Strategy 4: Intraday VWAP Continuation - Fractional Shares ALLOWED
    - Asset Universe: High Liquidity General (30-day average volume > 1,000,000 shares).
    - Entry Triggers: Trading above 20-day and 50-day SMA. Intraday price pulls back and touches VWAP on declining volume, RSI cooling to ~50.
    - Exit Plan: Target: Limit order at +3.0% (scalping the bounce). Stop-Loss: Hard stop at -1.5% below VWAP. Time Exit: Liquidate completely by 11:00 AM.

    OUTPUT FORMAT REQUIREMENT (After tool execution is complete):
    Format your final briefing strictly using this structure (exclude non-triggered strategies):

    ## 📅 Daily Briefing: Silly Stock Selector
    **Total Buying Power:** $[Buying Power] | **Invested Capital (Max 98%):** $[Amount Invested]
    **Pre-Market Sentiment:** [Brief overview of SPY/QQQ futures]

    ---

    ### Strategy [X]: [Ticker] - [Strategy Name] ([Whole/Fractional] Shares)
    * **Rationale & Technicals:** [Brief justification based on triggers]
    * **Entry Plan:** [Market/Marketable Limit] Order ([X] shares)
    * **Exit Plan:** Take Profit at $[Price] | Stop Loss at $[Price]
  `;

  let chat = ai.chats.create({
    model: modelName,
    config: {
      tools: [
        { functionDeclarations: mcpGeminiTools },
        { googleSearch: {} }
      ],
      toolConfig: {
        includeServerSideToolInvocations: true
      },
      systemInstruction: tradingSystemInstruction,
      temperature: 0.1 
    }
  });

  console.log(`Analyzing market conditions using ${modelName} and executing stock selection strategy autonomously...`);
  
  let response = await chat.sendMessage({ 
    message: "Begin your daily market analysis. Search the web for current futures, find stock candidates, calculate your allocations based on real current prices, and execute the BUY trades." 
  });

  while (response.functionCalls && response.functionCalls.length > 0) {
    let toolResponses = [];

    for (const call of response.functionCalls) {
      console.log(`\nExecuting tool: ${call.name} with arguments:`, JSON.stringify(call.args));
      
      if (activeMcpToolNames.includes(call.name)) {
        const toolResult = await mcpClient.callTool({
          name: call.name,
          arguments: call.args
        });
        
        console.log(`Tool Response from Robinhood:`, JSON.stringify(toolResult, null, 2));

        toolResponses.push({
          functionResponse: {
            name: call.name,
            response: { result: toolResult }
          }
        });
      }
    }

    if (toolResponses.length > 0) {
      response = await chat.sendMessage({
        message: toolResponses
      });
    } else {
       response = await chat.sendMessage({ message: "Continue." });
    }
  }

  // Phase 2: Built-in 10-minute wait period for fills, followed by bracket exit orders
  if (!response.text.includes("NO TRADE")) {
    console.log("\n--------------------------------------------------");
    console.log("Buy orders placed. Pausing for 10 minutes to allow market execution before staging exit brackets...");
    console.log("--------------------------------------------------");

    // 10 minutes (600,000 ms) wait before checking positions
    await sleep(600000); 

    console.log("Resuming session: Checking portfolio positions and submitting exit bracket orders...");
    
    let followUpResponse = await chat.sendMessage({
      message: "10 minutes have passed. Please call your get_positions tool to check our filled shares, and immediately place the corresponding Take-Profit and Stop-Loss sell orders for the active positions."
    });

    while (followUpResponse.functionCalls && followUpResponse.functionCalls.length > 0) {
      let followUpToolResponses = [];
      
      for (const call of followUpResponse.functionCalls) {
        console.log(`\nExecuting Robinhood tool: ${call.name} with arguments:`, JSON.stringify(call.args));
        
        if (activeMcpToolNames.includes(call.name)) {
          const toolResult = await mcpClient.callTool({
            name: call.name,
            arguments: call.args
          });

          console.log(`Tool Response from Robinhood:`, JSON.stringify(toolResult, null, 2));

          followUpToolResponses.push({
            functionResponse: {
              name: call.name,
              response: { result: toolResult }
            }
          });
        }
      }

      if (followUpToolResponses.length > 0) {
         followUpResponse = await chat.sendMessage({
           message: followUpToolResponses
         });
      } else {
         followUpResponse = await chat.sendMessage({ message: "Continue." });
      }
    }

    console.log("\n--------------------------------------------------");
    console.log(followUpResponse.text);
    console.log("--------------------------------------------------");
  } else {
    console.log("\n--------------------------------------------------");
    console.log(response.text);
    console.log("--------------------------------------------------");
  }

  await mcpClient.close();
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