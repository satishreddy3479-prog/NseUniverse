import { MultiStrikeBoard, PriceOiBoard } from "./dashboard/PriceBoards";
import { RollingStraddleBoard } from "./dashboard/RollingStraddle";
import { VegaAnalysisBoard } from "./dashboard/VegaAnalysis";
import { GammaAnalysisBoard } from "./dashboard/GammaAnalysis";
import { StrikePremiumBoard } from "./dashboard/StrikePremium";
import { IndexToolBody } from "./IndexTools";
import { FlowsPanel } from "./FlowsPanel";
import { CashPanel } from "./CashPanel";
import { FuturesFlowBody } from "./FuturesFlowTools";
import { FuturesBuildupBody } from "./FuturesBuildupTool";
import { IvChartBody } from "./IvChartPages";
import { SignalBacktestBody } from "./SignalBacktest";
import { MarketStructureBody } from "./MarketStructure";
import { StrikePositioningBody } from "./StrikePositioning";
import { IvMomentumBody } from "./IvMomentum";
import { IvSkewBody } from "./IvSkew";
import { IvHvBody, IvIntradayBody } from "./IvTools";
import { CalendarBody, GlobalBody, NewsBody } from "./GlobalPages";
import { ForwardBody } from "./ForwardTest";
import type { Tool } from "../lib/tools";

/**
 * What a tool shows below its heading: its chart board or its special page. One place, used by the tool page and by the Eagles view widgets,
 * so a tool is the same wherever it is opened. The chain widgets a tool stacks (``tool.widgets``) are drawn by the caller.
 */
export function ToolBody({ tool, expiry }: { tool: Tool; expiry: string | null }) {
  return (
    <>
      {tool.board === "vega" && <VegaAnalysisBoard />}
      {tool.board === "gamma" && <GammaAnalysisBoard />}
      {tool.board === "premiumChange" && <StrikePremiumBoard />}
      {tool.board === "priceOi" && <PriceOiBoard />}
      {tool.board === "multiStrike" && <MultiStrikeBoard straddle={false} />}
      {tool.board === "multiStraddle" && <MultiStrikeBoard straddle />}
      {tool.board === "rollingStraddle" && <RollingStraddleBoard />}
      {tool.page === "flows" && <FlowsPanel />}
      {tool.page === "cash" && <CashPanel />}
      {tool.page === "futflow" && <FuturesFlowBody expiry={expiry} part="flow" />}
      {tool.page === "futsectors" && <FuturesFlowBody expiry={expiry} part="sectors" />}
      {tool.page === "futbuildup" && <FuturesBuildupBody />}
      {tool.page === "ivhv" && <IvHvBody expiry={expiry} />}
      {tool.page === "ivintraday" && <IvIntradayBody expiry={expiry} />}
      {tool.page === "ivchart" && <IvChartBody />}
      {tool.page === "ivskew" && <IvSkewBody expiry={expiry} />}
      {tool.page === "ivmomentum" && <IvMomentumBody expiry={expiry} />}
      {tool.page === "strikepos" && <StrikePositioningBody expiry={expiry} />}
      {tool.page === "marketstructure" && <MarketStructureBody expiry={expiry} />}
      {tool.page === "backtest" && <SignalBacktestBody expiry={expiry} />}
      {tool.page === "global" && <GlobalBody />}
      {tool.page === "calendar" && <CalendarBody />}
      {tool.page === "news" && <NewsBody />}
      {tool.page === "forward" && <ForwardBody family="plain" />}
      {tool.page === "forwardcost" && <ForwardBody family="cost" />}
      {(tool.page === "contributors" || tool.page === "weightage" || tool.page === "breadth" || tool.page === "sectors" || tool.page === "movers") && <IndexToolBody page={tool.page} />}
    </>
  );
}

/** Whether a tool has a body of its own to show (a board or a special page): the tools that only stack chain widgets are covered by those widgets. */
export const hasToolBody = (t: Tool): boolean => !!t.board || !!t.page;
