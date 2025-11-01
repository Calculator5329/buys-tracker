import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  ReferenceLine,
  Scatter,
  Bar,
  BarChart,
  Tooltip,
  Cell,
} from 'recharts'
import './App.css'

type PricePoint = {
  dateMs: number
  close: number
}


type ProcessedTransaction = {
  dateMs: number
  symbol: string
  type: 'Buy' | 'Sell'
  quantity: number
  pricePerShare: number
  totalCost: number
  commission: number
  fees: number
  cashBalance?: number
}

type TickerSeries = Record<string, PricePoint[]>

// Custom triangle marker component
const TriangleMarker = (props: any) => {
  const { cx, cy, payload, onHover, onLeave } = props
  
  if (!payload || !payload.type || cx == null || cy == null) return null
  
  const isBuy = payload.type === 'Buy'
  const size = Math.max(6, Math.min(24, Number(payload.markerSize) || 10))
  // Place the top of the marker exactly at the y position of the data point (cost basis per share)
  const topY = cy
  
  // Triangle points ensuring the top of the triangle is at topY
  // Buy (up): apex at (cx, topY), base at topY + 2*size
  // Sell (down): base at topY, apex at topY + 2*size
  const points = isBuy 
    ? `${cx},${topY} ${cx - size},${topY + 2 * size} ${cx + size},${topY + 2 * size}`
    : `${cx - size},${topY - 2 * size} ${cx + size},${topY - 2 * size} ${cx},${topY}`
  
  return (
    <polygon
      points={points}
      fill={isBuy ? '#10b981' : '#ef4444'}
      stroke={isBuy ? '#059669' : '#dc2626'}
      strokeWidth={2}
      opacity={0.9}
      onMouseEnter={() => onHover && onHover(payload)}
      onMouseLeave={() => onLeave && onLeave()}
      style={{ cursor: 'pointer' }}
    />
  )
}

// Memoized chart component so hovering transactions doesn't re-render/animate the chart
type ChartViewProps = {
  priceData: PricePoint[]
  markers: Array<{
    dateMs: number
    close: number
    type: 'Buy' | 'Sell'
    quantity: number
    pricePerShare: number
    totalCost: number
    commission: number
    fees: number
    symbol: string
    markerSize?: number
  }>
  onMarkerHover: (t: any) => void
  windowStartMs: number
  windowEndMs: number
}

const ChartView = memo(function ChartView({ priceData, markers, onMarkerHover, windowStartMs, windowEndMs }: ChartViewProps) {
  return (
    <ResponsiveContainer width="100%" height={520}>
      <ComposedChart margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
        <defs>
          <linearGradient id="lineGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity={0.9} />
            <stop offset="100%" stopColor="#6366f1" stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
        <XAxis
          dataKey="dateMs"
          type="number"
          domain={["dataMin", "dataMax"]}
          padding={{ left: 0, right: 0 }}
          tickFormatter={(v: number) => new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}
          tick={{ fill: '#9aa4b2', fontSize: 12 }}
        />
        <YAxis
          domain={["dataMin", "dataMax"]}
          tick={{ fill: '#9aa4b2', fontSize: 12 }}
          tickFormatter={(v: number) => `$${v.toFixed(0)}`}
          width={72}
        />
        <Legend verticalAlign="top" height={24} wrapperStyle={{ color: '#9aa4b2' }} />
        <ReferenceLine y={0} stroke="#1f2937" />
        <Line
          data={priceData}
          type="monotone"
          dataKey="close"
          stroke="#60a5fa"
          strokeWidth={3}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
          isAnimationActive={false}
        />
        {markers.length > 0 && (
          <Scatter
            name="Transactions"
            data={markers.filter(m => m.dateMs >= windowStartMs && m.dateMs <= windowEndMs)}
            dataKey="close"
            fill="#10b981"
            isAnimationActive={false}
            shape={(props: any) => (
              <TriangleMarker {...props} onHover={onMarkerHover} onLeave={() => {}} />
            )}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
})

function App() {
  const [tickers, setTickers] = useState<string[]>([])
  const [selectedTicker, setSelectedTicker] = useState<string>('')
  const [seriesByTicker, setSeriesByTicker] = useState<TickerSeries>({})
  const [transactions, setTransactions] = useState<ProcessedTransaction[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [hoveredTransaction, setHoveredTransaction] = useState<ProcessedTransaction | null>(null)
  const [range, setRange] = useState<'ALL' | '5Y' | '3Y' | '1Y' | 'YTD'>('ALL')
  const [activeTab, setActiveTab] = useState<'TICKER' | 'PORTFOLIO'>('TICKER')
  const [portfolioChartMode, setPortfolioChartMode] = useState<'TOTAL' | 'CASH'>('TOTAL')
  const [transfersRange, setTransfersRange] = useState<'ALL' | '5Y' | '3Y' | '1Y' | 'YTD'>('ALL')
  const [transfersCumulative, setTransfersCumulative] = useState<boolean>(false)
  const [csvSource, setCsvSource] = useState<'ET' | 'MOM'>('ET')

  // Note: actual hover handler defined after selectedTransactions for stable reference

  // Function to load and process transactions
  async function loadTransactions(): Promise<ProcessedTransaction[]> {
    try {
      const response = await fetch(`/${csvSource}/transactions.csv`)
      if (!response.ok) {
        console.warn('Transactions file not found, continuing without transaction data')
        return []
      }
      const text = await response.text()

      const parsed = Papa.parse<string[]>(text, {
        delimiter: ',',
        skipEmptyLines: true,
        header: false,
      })

      const rows = parsed.data as unknown as string[][]
      if (!rows || rows.length < 2) return []

      const processedTransactions: ProcessedTransaction[] = []
      
      // Skip header row (index 0)
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]
        if (!row || row.length < 13) continue

        const runDate = row[0]?.trim()
        const action = row[1]?.trim()
        const symbol = row[2]?.trim()
        const quantityStr = row[5]?.trim()
        const priceStr = row[6]?.trim()
        const commissionStr = row[7]?.trim() || '0'
        const feesStr = row[8]?.trim() || '0'
        const cashBalanceStr = row[11]?.trim() // Column 11 is "Cash Balance ($)"

        if (!runDate || !symbol || !quantityStr || !priceStr) continue

        const dateMs = Date.parse(runDate)
        const quantity = Number.parseFloat(quantityStr)
        const price = Number.parseFloat(priceStr)
        const commission = Number.parseFloat(commissionStr) || 0
        const fees = Number.parseFloat(feesStr) || 0
        const cashBalance = cashBalanceStr ? Number.parseFloat(cashBalanceStr) : undefined

        if (!Number.isFinite(dateMs) || !Number.isFinite(quantity) || !Number.isFinite(price)) continue

        // Determine if it's a buy or sell based on action and quantity
        const isBuy = action.includes('BOUGHT') || quantity > 0
        const transactionType: 'Buy' | 'Sell' = isBuy ? 'Buy' : 'Sell'
        const absQuantity = Math.abs(quantity)

        processedTransactions.push({
          dateMs,
          symbol,
          type: transactionType,
          quantity: absQuantity,
          pricePerShare: price,
          totalCost: absQuantity * price,
          commission,
          fees,
          cashBalance: Number.isFinite(cashBalance) ? cashBalance : undefined,
        })
      }

      return processedTransactions.sort((a, b) => a.dateMs - b.dateMs)
    } catch (e) {
      console.warn('Error loading transactions:', e)
      return []
    }
  }

  useEffect(() => {
    let cancelled = false
    async function loadData() {
      try {
        // Load stock data and transactions in parallel
        const [stockResponse, transactionData] = await Promise.all([
          fetch(`/${csvSource}/stock-values.csv`),
          loadTransactions()
        ])

        if (!stockResponse.ok) throw new Error(`Failed to load CSV: ${stockResponse.status}`)
        const text = await stockResponse.text()

        const parsed = Papa.parse<string[]>(text, {
          delimiter: ',',
          skipEmptyLines: true,
        })

        const rows = parsed.data as unknown as string[][]
        if (!rows || rows.length < 3) throw new Error('CSV missing expected rows')

        const headerRow = rows[0]
        const candidateTickerIndices: number[] = []
        const foundTickers: string[] = []
        for (let i = 0; i < headerRow.length; i++) {
          const cell = (headerRow[i] ?? '').trim()
          if (cell) {
            foundTickers.push(cell)
            candidateTickerIndices.push(i)
          }
        }

        // Build series per ticker using rows starting from index 2 (skip header and Date/Close row)
        const byTicker: TickerSeries = {}
        for (let t = 0; t < candidateTickerIndices.length; t++) {
          const idx = candidateTickerIndices[t]
          const ticker = foundTickers[t]
          const points: PricePoint[] = []
          for (let r = 2; r < rows.length; r++) {
            const row = rows[r]
            const dateStr = row[idx]
            const closeStr = row[idx + 1]
            if (!dateStr || !closeStr) continue
            const dateMs = Date.parse(dateStr)
            const close = Number.parseFloat(closeStr)
            if (Number.isFinite(dateMs) && Number.isFinite(close)) {
              points.push({ dateMs, close })
            }
          }
          // Ensure chronological order, in case of any disorder
          points.sort((a, b) => a.dateMs - b.dateMs)
          byTicker[ticker] = points
        }

        if (!cancelled) {
          setSeriesByTicker(byTicker)
          
          // Filter tickers to only include specified ones
          const allowedTickers = ['META', 'GOOGL', 'AMZN', 'PYPL', 'TXRH', 'ADBE', 'CRM', 'TSLA', 'AMD', 'ASML', 'NKE', 'DUOL']
          const filteredTickers = foundTickers.filter(ticker => allowedTickers.includes(ticker))
          
          setTickers(filteredTickers)
          // Only set selected ticker if it's not already selected or if the current selection is not in the new list
          if (!selectedTicker || !filteredTickers.includes(selectedTicker)) {
            setSelectedTicker(filteredTickers[0] ?? '')
          }
          setTransactions(transactionData)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Unknown error parsing CSV')
          setLoading(false)
        }
      }
    }
    loadData()
    return () => {
      cancelled = true
    }
  }, [csvSource])

  const selectedData = useMemo<PricePoint[]>(() => {
    return seriesByTicker[selectedTicker] ?? []
  }, [seriesByTicker, selectedTicker])

  // Build a case-insensitive set of known tickers from price data
  const knownTickersUpper = useMemo<Set<string>>(() => {
    const s = new Set<string>()
    for (const t of tickers) s.add((t || '').toUpperCase())
    return s
  }, [tickers])

  const selectedTransactions = useMemo<ProcessedTransaction[]>(() => {
    const sel = (selectedTicker || '').toUpperCase()
    const filtered = transactions.filter(t => {
      const sym = (t.symbol || '').toUpperCase()
      return sym === sel && knownTickersUpper.has(sym)
    })
    try {
      const filteredSample = filtered.slice(0, 5).map(t => ({
        date: new Date(t.dateMs).toISOString().slice(0, 10),
        symbol: t.symbol,
        type: t.type,
        quantity: t.quantity,
        pricePerShare: t.pricePerShare,
      }))
      const nonSelectedSample = transactions
        .filter(t => (t.symbol || '').toUpperCase() !== sel && knownTickersUpper.has((t.symbol || '').toUpperCase()))
        .slice(0, 5)
        .map(t => ({ symbol: t.symbol, type: t.type }))
      // Diagnostic logs for debugging transaction filtering per stock
      console.log('[transactions] filter', {
        selectedTicker,
        total: transactions.length,
        filtered: filtered.length,
        filteredSample,
        nonSelectedSample,
      })
    } catch (_) { /* no-op */ }
    return filtered
  }, [transactions, selectedTicker, knownTickersUpper])

  // Always sort transactions newest to oldest for display
  const selectedTransactionsSortedDesc = useMemo<ProcessedTransaction[]>(() => {
    const toMs = (t: ProcessedTransaction) => Number.isFinite(t.dateMs) ? t.dateMs : -Infinity
    return [...selectedTransactions].sort((a, b) => toMs(b) - toMs(a))
  }, [selectedTransactions])

  // Compute the time window based on selected range using the latest available data point
  const [windowStartMs, windowEndMs] = useMemo<[number, number]>(() => {
    if (selectedData.length === 0) return [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
    const end = selectedData[selectedData.length - 1].dateMs
    if (range === 'ALL') return [selectedData[0].dateMs, end]
    const years = range === '5Y' ? 5 : range === '3Y' ? 3 : range === '1Y' ? 1 : 0
    if (range === 'YTD') {
      const d = new Date(end)
      const ytdStart = new Date(d.getFullYear(), 0, 1).getTime()
      return [ytdStart, end]
    }
    const ms = years * 365.25 * 24 * 3600 * 1000
    return [end - ms, end]
  }, [selectedData, range])

  // Filter data by window
  const filteredPriceData = useMemo<PricePoint[]>(() => {
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) return selectedData
    return selectedData.filter(p => p.dateMs >= windowStartMs && p.dateMs <= windowEndMs)
  }, [selectedData, windowStartMs, windowEndMs])

  // Re-stabilize hover handler once selectedTransactions changes
  const onMarkerHover = useCallback((payload: any) => {
    // Payload contains the precise marker's data including size scaling
    if (!payload) return
    setHoveredTransaction({
      dateMs: payload.dateMs,
      symbol: payload.symbol ?? selectedTicker,
      type: payload.type,
      quantity: payload.quantity,
      pricePerShare: payload.pricePerShare,
      totalCost: payload.totalCost,
      commission: payload.commission ?? 0,
      fees: payload.fees ?? 0,
    })
  }, [selectedTicker])

  // Prepare transaction data for scatter plot - position at stock price on transaction date
  const transactionMarkers = useMemo(() => {
    if (selectedTransactions.length === 0 || selectedData.length === 0) {
      return []
    }

    // Include: all sells; buys only if total purchase amount >= $15
    const buyTransactionsOverThreshold = selectedTransactions.filter(t => {
      if (t.type !== 'Buy') return false
      const totalPurchase = t.quantity * t.pricePerShare
      return totalPurchase >= 15
    })
    const sellTransactions = selectedTransactions.filter(t => t.type === 'Sell')

    // Determine size scale based on total cost among included transactions
    const minCost = buyTransactionsOverThreshold.reduce((m, t) => Math.min(m, t.totalCost), Infinity)
    const maxCost = buyTransactionsOverThreshold.reduce((m, t) => Math.max(m, t.totalCost), -Infinity)
    const minSize = 8
    const maxSize = 22
    const scaleSize = (cost: number) => {
      if (!Number.isFinite(minCost) || !Number.isFinite(maxCost)) return (minSize + maxSize) / 2
      if (maxCost <= minCost) return (minSize + maxSize) / 2
      const ratio = (cost - minCost) / (maxCost - minCost)
      return minSize + ratio * (maxSize - minSize)
    }

    const buyMarkers = buyTransactionsOverThreshold.map(transaction => {
      // We position markers using cost basis per share, so no need to look up price series here

      // Cost basis per share at the time of transaction, including commissions and fees
      const costBasisPerShare = transaction.quantity > 0
        ? (transaction.quantity * transaction.pricePerShare + transaction.commission + transaction.fees) / transaction.quantity
        : transaction.pricePerShare

      return {
        dateMs: transaction.dateMs,
        // Position marker on chart at cost basis per share
        close: costBasisPerShare,
        type: transaction.type,
        quantity: transaction.quantity,
        pricePerShare: transaction.pricePerShare,
        totalCost: transaction.totalCost,
        commission: transaction.commission,
        fees: transaction.fees,
        symbol: selectedTicker,
        markerSize: scaleSize(transaction.totalCost),
        costBasisPerShare,
      }
    })
    const sellMarkers = sellTransactions.map(transaction => {
      return {
        dateMs: transaction.dateMs,
        // Plot sells at their trade price per share
        close: transaction.pricePerShare,
        type: transaction.type,
        quantity: transaction.quantity,
        pricePerShare: transaction.pricePerShare,
        totalCost: transaction.totalCost,
        commission: transaction.commission,
        fees: transaction.fees,
        symbol: selectedTicker,
        // Keep sells at a consistent size; TriangleMarker defaults when markerSize is absent
      }
    })
    
    return [...buyMarkers, ...sellMarkers]
  }, [selectedTransactions, selectedData])

  // --- Portfolio time series (equity and cash over time) ---
  type PortfolioPoint = { dateMs: number; equity: number; cash: number; total: number }
  const portfolioSeries = useMemo<PortfolioPoint[]>(() => {
    if (Object.keys(seriesByTicker).length === 0) return []
    // Collect all unique dates present across tickers
    const allDates = new Set<number>()
    for (const t of Object.keys(seriesByTicker)) {
      for (const p of seriesByTicker[t]) allDates.add(p.dateMs)
    }
    const datesAsc = Array.from(allDates).sort((a, b) => a - b)

    // Prepare per-ticker price pointer
    const priceIndexByTicker: Record<string, number> = {}
    const currentPriceByTicker: Record<string, number> = {}
    for (const t of Object.keys(seriesByTicker)) {
      priceIndexByTicker[t] = 0
      currentPriceByTicker[t] = seriesByTicker[t][0]?.close ?? 0
    }

    // Prepare transactions per ticker, sorted
    const txByTicker: Record<string, ProcessedTransaction[]> = {}
    for (const t of Object.keys(seriesByTicker)) {
      txByTicker[t] = transactions.filter(x => x.symbol === t).sort((a, b) => a.dateMs - b.dateMs)
    }
    const txPtrByTicker: Record<string, number> = {}
    const sharesHeldByTicker: Record<string, number> = {}
    // Track latest known cash balance from transactions
    let latestCashBalance: number | undefined = undefined
    for (const t of Object.keys(seriesByTicker)) {
      txPtrByTicker[t] = 0
      sharesHeldByTicker[t] = 0
    }

    const points: PortfolioPoint[] = []
    for (const d of datesAsc) {
      // advance prices per ticker to current date
      for (const t of Object.keys(seriesByTicker)) {
        const series = seriesByTicker[t]
        let idx = priceIndexByTicker[t]
        while (idx + 1 < series.length && series[idx + 1].dateMs <= d) {
          idx++
        }
        priceIndexByTicker[t] = idx
        currentPriceByTicker[t] = series[idx]?.close ?? currentPriceByTicker[t]
      }

      // apply any transactions up to and including this date
      for (const t of Object.keys(seriesByTicker)) {
        const list = txByTicker[t]
        let ptr = txPtrByTicker[t]
        while (ptr < list.length && list[ptr].dateMs <= d) {
          const tx = list[ptr]
          if (tx.type === 'Buy') {
            sharesHeldByTicker[t] += tx.quantity
          } else {
            const qty = tx.quantity
            sharesHeldByTicker[t] = Math.max(0, sharesHeldByTicker[t] - qty)
          }
          // Update cash balance if transaction has it
          if (tx.cashBalance !== undefined) {
            latestCashBalance = tx.cashBalance
          }
          ptr++
        }
        txPtrByTicker[t] = ptr
      }

      // compute equity
      let equity = 0
      for (const t of Object.keys(seriesByTicker)) {
        const shares = sharesHeldByTicker[t]
        if (shares > 0) equity += shares * (currentPriceByTicker[t] ?? 0)
      }
      // Use actual cash balance if available, otherwise default to 0
      const cash = latestCashBalance ?? 0
      points.push({ dateMs: d, equity, cash, total: equity + cash })
    }
    return points
  }, [seriesByTicker, transactions])

  // --- Comprehensive Portfolio Metrics ---
  const portfolioMetrics = useMemo(() => {
    if (portfolioSeries.length === 0 || transactions.length === 0) {
      return {
        currentValue: 0,
        totalInvested: 0,
        totalWithdrawn: 0,
        netInvested: 0,
        totalGain: 0,
        totalGainPct: 0,
        realizedGain: 0,
        unrealizedGain: 0,
        annualizedReturn: 0,
        maxDrawdown: 0,
        maxDrawdownPct: 0,
        bestDayGain: 0,
        worstDayGain: 0,
        totalDays: 0,
      }
    }

    const latest = portfolioSeries[portfolioSeries.length - 1]
    const currentValue = latest.total

    // Compute total invested and withdrawn
    let totalInvested = 0
    let totalWithdrawn = 0
    let realizedGain = 0
    const costBasisByTicker: Record<string, { shares: number; basis: number }> = {}
    for (const t of Object.keys(seriesByTicker)) {
      costBasisByTicker[t] = { shares: 0, basis: 0 }
    }

    const allTxSorted = [...transactions].sort((a, b) => a.dateMs - b.dateMs)
    for (const tx of allTxSorted) {
      const t = tx.symbol
      if (!costBasisByTicker[t]) costBasisByTicker[t] = { shares: 0, basis: 0 }
      if (tx.type === 'Buy') {
        const cost = tx.quantity * tx.pricePerShare + tx.commission + tx.fees
        totalInvested += cost
        costBasisByTicker[t].shares += tx.quantity
        costBasisByTicker[t].basis += cost
      } else {
        const proceeds = tx.quantity * tx.pricePerShare - tx.commission - tx.fees
        totalWithdrawn += proceeds
        const cb = costBasisByTicker[t]
        if (cb.shares > 0) {
          const avgCost = cb.basis / cb.shares
          const qty = Math.min(tx.quantity, cb.shares)
          const costOfSold = qty * avgCost
          realizedGain += proceeds - costOfSold
          cb.shares -= qty
          cb.basis -= costOfSold
        }
      }
    }

    const netInvested = totalInvested - totalWithdrawn
    const totalGain = currentValue - netInvested
    const totalGainPct = netInvested > 0 ? (totalGain / netInvested) * 100 : 0

    // Unrealized gain
    let unrealizedGain = 0
    for (const t of Object.keys(costBasisByTicker)) {
      const cb = costBasisByTicker[t]
      if (cb.shares > 0) {
        const lastPrice = seriesByTicker[t]?.at(-1)?.close ?? 0
        const marketValue = cb.shares * lastPrice
        unrealizedGain += marketValue - cb.basis
      }
    }

    // Annualized return
    const firstDate = portfolioSeries[0].dateMs
    const lastDate = latest.dateMs
    const daysElapsed = (lastDate - firstDate) / (1000 * 60 * 60 * 24)
    const yearsElapsed = daysElapsed / 365.25
    const annualizedReturn = yearsElapsed > 0 && netInvested > 0
      ? (Math.pow(currentValue / netInvested, 1 / yearsElapsed) - 1) * 100
      : 0

    // Max drawdown
    let peak = 0
    let maxDD = 0
    let maxDDPct = 0
    for (const p of portfolioSeries) {
      if (p.total > peak) peak = p.total
      const dd = peak - p.total
      const ddPct = peak > 0 ? (dd / peak) * 100 : 0
      if (dd > maxDD) {
        maxDD = dd
        maxDDPct = ddPct
      }
    }

    // Best/worst day
    let bestDay = 0
    let worstDay = 0
    const dailyChanges: Array<{ date: string; change: number; previousValue: number; newValue: number }> = []
    
    for (let i = 1; i < portfolioSeries.length; i++) {
      const change = portfolioSeries[i].total - portfolioSeries[i - 1].total
      if (change > bestDay) bestDay = change
      if (change < worstDay) worstDay = change
      
      dailyChanges.push({
        date: new Date(portfolioSeries[i].dateMs).toLocaleDateString(),
        change,
        previousValue: portfolioSeries[i - 1].total,
        newValue: portfolioSeries[i].total
      })
    }
    
    // Log top 5 best days
    const top5BestDays = dailyChanges
      .filter(d => d.change > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, 5)
    
    console.log('🏆 Top 5 Best Portfolio Days:')
    top5BestDays.forEach((day, index) => {
      const percentIncrease = (day.change / day.previousValue) * 100
      console.log(`${index + 1}. ${day.date}: +$${day.change.toFixed(2)} (${percentIncrease.toFixed(2)}%) - $${day.previousValue.toFixed(2)} → $${day.newValue.toFixed(2)}`)
    })

    return {
      currentValue,
      totalInvested,
      totalWithdrawn,
      netInvested,
      totalGain,
      totalGainPct,
      realizedGain,
      unrealizedGain,
      annualizedReturn,
      maxDrawdown: maxDD,
      maxDrawdownPct: maxDDPct,
      bestDayGain: bestDay,
      worstDayGain: worstDay,
      totalDays: portfolioSeries.length,
    }
  }, [portfolioSeries, transactions, seriesByTicker])

  // Filter portfolio series to start at 2/1/2023
  const filteredPortfolioSeries = useMemo(() => {
    const startDate = new Date('2023-02-01').getTime()
    return portfolioSeries.filter(point => point.dateMs >= startDate)
  }, [portfolioSeries])

  // Current holdings breakdown
  const holdingsBreakdown = useMemo(() => {
    if (portfolioSeries.length === 0) return []
    
    const holdings: { ticker: string; value: number; shares: number }[] = []
    const costBasisByTicker: Record<string, { shares: number; basis: number }> = {}
    
    for (const t of Object.keys(seriesByTicker)) {
      costBasisByTicker[t] = { shares: 0, basis: 0 }
    }

    const allTxSorted = [...transactions].sort((a, b) => a.dateMs - b.dateMs)
    for (const tx of allTxSorted) {
      const t = tx.symbol
      if (!costBasisByTicker[t]) costBasisByTicker[t] = { shares: 0, basis: 0 }
      if (tx.type === 'Buy') {
        costBasisByTicker[t].shares += tx.quantity
        costBasisByTicker[t].basis += tx.quantity * tx.pricePerShare + tx.commission + tx.fees
      } else {
        const cb = costBasisByTicker[t]
        if (cb.shares > 0) {
          const avgCost = cb.basis / cb.shares
          const qty = Math.min(tx.quantity, cb.shares)
          cb.shares -= qty
          cb.basis -= qty * avgCost
        }
      }
    }

    for (const t of Object.keys(costBasisByTicker)) {
      const cb = costBasisByTicker[t]
      if (cb.shares > 0.001) {
        const lastPrice = seriesByTicker[t]?.at(-1)?.close ?? 0
        holdings.push({
          ticker: t,
          value: cb.shares * lastPrice,
          shares: cb.shares,
        })
      }
    }

    return holdings.sort((a, b) => b.value - a.value)
  }, [portfolioSeries, transactions, seriesByTicker])

  // Transaction activity by month
  const transactionActivity = useMemo(() => {
    const activityByMonth: Record<string, { buys: number; sells: number; netCash: number }> = {}
    
    for (const tx of transactions) {
      const d = new Date(tx.dateMs)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!activityByMonth[key]) {
        activityByMonth[key] = { buys: 0, sells: 0, netCash: 0 }
      }
      
      if (tx.type === 'Buy') {
        const buyVolume = tx.quantity * tx.pricePerShare + tx.commission + tx.fees
        activityByMonth[key].buys += buyVolume
        activityByMonth[key].netCash -= buyVolume
      } else {
        const sellVolume = tx.quantity * tx.pricePerShare - tx.commission - tx.fees
        activityByMonth[key].sells += sellVolume
        activityByMonth[key].netCash += sellVolume
      }
    }

    return Object.entries(activityByMonth)
      .map(([month, data]) => ({ month, ...data }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-24) // Last 24 months
  }, [transactions])

  // Monthly transfers (cash increases not from sales)
  const monthlyTransfers = useMemo(() => {
    const transfersByMonth: Record<string, number> = {}
    const txSorted = [...transactions].sort((a, b) => a.dateMs - b.dateMs)
    
    let prevCashBalance: number | undefined = undefined
    for (const tx of txSorted) {
      if (tx.cashBalance === undefined) continue
      
      const d = new Date(tx.dateMs)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      
      if (prevCashBalance !== undefined) {
        const cashChange = tx.cashBalance - prevCashBalance
        // Expected change from this transaction
        const expectedChange = tx.type === 'Buy' 
          ? -(tx.quantity * tx.pricePerShare + tx.commission + tx.fees)
          : (tx.quantity * tx.pricePerShare - tx.commission - tx.fees)
        
        // Transfer = actual change - expected change from transaction
        const transfer = cashChange - expectedChange
        
        if (Math.abs(transfer) > 0.01) { // Only count meaningful transfers
          if (!transfersByMonth[key]) transfersByMonth[key] = 0
          transfersByMonth[key] += transfer
        }
      }
      
      prevCashBalance = tx.cashBalance
    }

    const allMonths = Object.entries(transfersByMonth)
      .map(([month, transfer]) => ({ month, transfer }))
      .sort((a, b) => a.month.localeCompare(b.month))

    // Apply time range filter
    const now = new Date()
    const cutoffDate = transfersRange === 'ALL' ? new Date(0) :
      transfersRange === '5Y' ? new Date(now.getFullYear() - 5, now.getMonth(), 1) :
      transfersRange === '3Y' ? new Date(now.getFullYear() - 3, now.getMonth(), 1) :
      transfersRange === '1Y' ? new Date(now.getFullYear() - 1, now.getMonth(), 1) :
      new Date(now.getFullYear(), 0, 1) // YTD
    
    const cutoffKey = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}`
    const filtered = allMonths.filter(m => m.month >= cutoffKey && m.month !== '2023-01')

    // Apply cumulative mode
    if (transfersCumulative) {
      let cumulative = 0
      return filtered.map(m => {
        cumulative += m.transfer
        return { month: m.month, transfer: cumulative }
      })
    }

    return filtered
  }, [transactions, transfersRange, transfersCumulative])

  // Monthly activity by stock
  const monthlyStockActivity = useMemo(() => {
    const activityByMonth: Record<string, Record<string, { buys: number; sells: number }>> = {}
    
    for (const tx of transactions) {
      const d = new Date(tx.dateMs)
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const stock = tx.symbol
      
      if (!activityByMonth[monthKey]) {
        activityByMonth[monthKey] = {}
      }
      if (!activityByMonth[monthKey][stock]) {
        activityByMonth[monthKey][stock] = { buys: 0, sells: 0 }
      }
      
      const amount = tx.quantity * tx.pricePerShare + (tx.type === 'Buy' ? tx.commission + tx.fees : -(tx.commission + tx.fees))
      
      if (tx.type === 'Buy') {
        activityByMonth[monthKey][stock].buys += amount
      } else {
        activityByMonth[monthKey][stock].sells += amount
      }
    }

    // Convert to array format and sort by month
    const monthlyData = Object.entries(activityByMonth)
      .map(([month, stocks]) => ({
        month,
        stocks: Object.entries(stocks).map(([stock, activity]) => ({
          stock,
          ...activity
        }))
      }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12) // Last 12 months

    return monthlyData
  }, [transactions])

  // Aggregate metrics for selected ticker using average cost method
  const metrics = useMemo(() => {
    if (selectedTransactions.length === 0) {
      return {
        sharesHeld: 0,
        avgCostPerShare: 0,
        totalCostBasis: 0,
        marketValue: 0,
        unrealizedGain: 0,
        unrealizedGainPct: 0,
        lastPrice: selectedData.at(-1)?.close ?? 0,
        realizedGainTotal: 0,
        realizedGainTotalPct: 0,
      }
    }

    let sharesHeld = 0
    let costBasis = 0
    let realizedGainTotal = 0
    let realizedCostBasisTotal = 0

    // Process chronologically
    const txs = [...selectedTransactions].sort((a, b) => a.dateMs - b.dateMs)
    for (const t of txs) {
      if (t.type === 'Buy') {
        sharesHeld += t.quantity
        costBasis += t.quantity * t.pricePerShare + t.commission + t.fees
      } else {
        // Reduce position by average cost
        const avgCost = sharesHeld > 0 ? costBasis / sharesHeld : 0
        const qty = Math.min(t.quantity, sharesHeld)
        // Realized gain based on average-cost method
        realizedGainTotal += qty * (t.pricePerShare - avgCost)
        realizedCostBasisTotal += qty * avgCost
        sharesHeld -= qty
        costBasis -= qty * avgCost
      }
    }

    const lastPrice = selectedData.at(-1)?.close ?? 0
    const avgCostPerShare = sharesHeld > 0 ? costBasis / sharesHeld : 0
    const marketValue = sharesHeld * lastPrice
    const unrealizedGain = marketValue - costBasis
    const unrealizedGainPct = costBasis > 0 ? (unrealizedGain / costBasis) * 100 : 0

    return {
      sharesHeld,
      avgCostPerShare,
      totalCostBasis: costBasis,
      marketValue,
      unrealizedGain,
      unrealizedGainPct,
      lastPrice,
      realizedGainTotal,
      realizedGainTotalPct: realizedCostBasisTotal > 0 ? (realizedGainTotal / realizedCostBasisTotal) * 100 : 0,
    }
  }, [selectedTransactions, selectedData])

  return (
    <div className="dashboard">
      <h1 className="title">Stock Price History</h1>
      <div className="toolbar">
        <label className="label" htmlFor="ticker-select">Ticker</label>
        <select
          id="ticker-select"
          className="select"
          value={selectedTicker}
          onChange={(e) => setSelectedTicker(e.target.value)}
          disabled={loading || !!error}
        >
          {tickers.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 16 }}>
          <label className="label" style={{ margin: 0 }}>Data Source</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={() => setCsvSource('ET')}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: csvSource === 'ET' ? '2px solid #60a5fa' : '1px solid #2d3748',
                background: csvSource === 'ET' ? '#1e3a8a' : '#0b1220',
                color: csvSource === 'ET' ? '#60a5fa' : '#9aa4b2',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              ET
            </button>
            <button
              onClick={() => setCsvSource('MOM')}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: csvSource === 'MOM' ? '2px solid #60a5fa' : '1px solid #2d3748',
                background: csvSource === 'MOM' ? '#1e3a8a' : '#0b1220',
                color: csvSource === 'MOM' ? '#60a5fa' : '#9aa4b2',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              MOM
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="error">{error}</div>
      )}

      {/* Transaction info panel - shows last hovered transaction */}
      {selectedTransactions.length > 0 && (
        <div style={{
          backgroundColor: '#1a1f2e',
          border: '1px solid #2d3748',
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '16px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '16px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
          transition: 'all 0.2s ease'
        }}>
          {hoveredTransaction ? (
            <>
              <div>
                <div style={{ fontSize: '12px', color: '#9aa4b2', marginBottom: '4px' }}>Transaction Type</div>
                <div style={{ 
                  fontSize: '16px', 
                  fontWeight: 'bold', 
                  color: hoveredTransaction.type === 'Buy' ? '#10b981' : '#ef4444' 
                }}>
                  {hoveredTransaction.type === 'Buy' ? '▲' : '▼'} {hoveredTransaction.type}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: '#9aa4b2', marginBottom: '4px' }}>Date</div>
                <div style={{ fontSize: '16px', fontWeight: '600', color: '#e5e7eb' }}>
                  {new Date(hoveredTransaction.dateMs).toLocaleDateString(undefined, { 
                    year: 'numeric', 
                    month: 'short', 
                    day: '2-digit' 
                  })}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: '#9aa4b2', marginBottom: '4px' }}>Shares</div>
                <div style={{ fontSize: '16px', fontWeight: '600', color: '#e5e7eb' }}>
                  {hoveredTransaction.quantity}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: '#9aa4b2', marginBottom: '4px' }}>Cost Basis / Share</div>
                <div style={{ fontSize: '16px', fontWeight: '600', color: '#e5e7eb' }}>
                  ${hoveredTransaction.pricePerShare.toFixed(2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: '#9aa4b2', marginBottom: '4px' }}>Total Cost Basis</div>
                <div style={{ fontSize: '16px', fontWeight: '600', color: '#e5e7eb' }}>
                  ${hoveredTransaction.totalCost.toFixed(2)}
                </div>
              </div>
              {(hoveredTransaction.commission > 0 || hoveredTransaction.fees > 0) && (
                <div>
                  <div style={{ fontSize: '12px', color: '#9aa4b2', marginBottom: '4px' }}>Fees</div>
                  <div style={{ fontSize: '16px', fontWeight: '600', color: '#e5e7eb' }}>
                    ${(hoveredTransaction.commission + hoveredTransaction.fees).toFixed(2)}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ 
              gridColumn: '1 / -1', 
              textAlign: 'center', 
              color: '#9aa4b2',
              padding: '8px',
              fontStyle: 'italic'
            }}>
              Hover over a transaction marker to view details
            </div>
          )}
        </div>
      )}

      {/* Range selector */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <span className="label">Range</span>
        {([
          { key: 'ALL', label: 'All' },
          { key: '5Y', label: '5y' },
          { key: '3Y', label: '3y' },
          { key: '1Y', label: '1y' },
          { key: 'YTD', label: 'YTD' },
        ] as const).map(btn => (
          <button
            key={btn.key}
            onClick={() => setRange(btn.key)}
            className={`pill ${range === btn.key ? 'active' : ''}`}
            style={{
              padding: '6px 10px',
              borderRadius: 999,
              border: '1px solid #2d3748',
              background: range === btn.key ? '#0f172a' : '#0b1220',
              color: '#e5e7eb',
            }}
          >
            {btn.label}
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 12, marginTop: 16, marginBottom: 12 }}>
        {([
          { key: 'TICKER', label: '📊 Ticker Analysis', icon: '📊' },
          { key: 'PORTFOLIO', label: '💼 Portfolio Dashboard', icon: '💼' },
        ] as const).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: activeTab === tab.key ? '2px solid #60a5fa' : '1px solid #2d3748',
              background: activeTab === tab.key ? 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)' : '#0b1220',
              color: activeTab === tab.key ? '#60a5fa' : '#9aa4b2',
              fontWeight: activeTab === tab.key ? 700 : 500,
              fontSize: 15,
              cursor: 'pointer',
              transition: 'all 0.2s',
              boxShadow: activeTab === tab.key ? '0 4px 12px rgba(96, 165, 250, 0.25)' : 'none',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'TICKER' ? (
        <>
      <div className="chart-card">
        <div className="chart-header">
          <div className="badge">{selectedTicker || '—'}</div>
              {selectedTransactions.length > 0 && (
                <div style={{ marginLeft: 'auto', color: '#9aa4b2', fontSize: 14 }}>
                  Realized Gain: <span className={metrics.realizedGainTotal >= 0 ? 'pos' : 'neg'}>{metrics.realizedGainTotal >= 0 ? '+' : ''}${Math.abs(metrics.realizedGainTotal).toFixed(2)}</span>
                </div>
              )}
        </div>
        {loading ? (
          <div className="loading">Loading data…</div>
        ) : (
          <ChartView
            priceData={filteredPriceData}
            markers={transactionMarkers}
            onMarkerHover={onMarkerHover}
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
          />
        )}
      </div>
        </>
      ) : (
        <>
          {/* Portfolio Dashboard */}
          <div style={{ marginBottom: 16 }}>
            <h2 style={{ margin: '0 0 16px 0', fontSize: '1.5rem', color: '#e6e8f0' }}>📈 Portfolio Overview</h2>
            
            {/* Key Metrics Grid */}
            <div className="metrics-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <div className="metric-card">
                <div className="metric-label">Current Value</div>
                <div className="metric-value">${portfolioMetrics.currentValue.toFixed(2)}</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Total Invested</div>
                <div className="metric-value">${portfolioMetrics.totalInvested.toFixed(2)}</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Total Gain</div>
                <div className={`metric-value ${portfolioMetrics.totalGain >= 0 ? 'pos' : 'neg'}`}>
                  {portfolioMetrics.totalGain >= 0 ? '+' : ''}${Math.abs(portfolioMetrics.totalGain).toFixed(2)} ({portfolioMetrics.totalGainPct.toFixed(2)}%)
                </div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Annualized Return</div>
                <div className={`metric-value ${portfolioMetrics.annualizedReturn >= 0 ? 'pos' : 'neg'}`}>
                  {portfolioMetrics.annualizedReturn >= 0 ? '+' : ''}{portfolioMetrics.annualizedReturn.toFixed(2)}%
                </div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Realized Gain</div>
                <div className={`metric-value ${portfolioMetrics.realizedGain >= 0 ? 'pos' : 'neg'}`}>
                  {portfolioMetrics.realizedGain >= 0 ? '+' : ''}${Math.abs(portfolioMetrics.realizedGain).toFixed(2)}
                </div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Unrealized Gain</div>
                <div className={`metric-value ${portfolioMetrics.unrealizedGain >= 0 ? 'pos' : 'neg'}`}>
                  {portfolioMetrics.unrealizedGain >= 0 ? '+' : ''}${Math.abs(portfolioMetrics.unrealizedGain).toFixed(2)}
                </div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Max Drawdown</div>
                <div className="metric-value neg">
                  -${portfolioMetrics.maxDrawdown.toFixed(2)} ({portfolioMetrics.maxDrawdownPct.toFixed(2)}%)
                </div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Best Day</div>
                <div className="metric-value pos">+${portfolioMetrics.bestDayGain.toFixed(2)}</div>
              </div>
            </div>

            {/* Portfolio Value Chart */}
            <div className="chart-card" style={{ marginTop: 16 }}>
              <div className="chart-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#e6e8f0' }}>
                  💰 {portfolioChartMode === 'TOTAL' ? 'Total Portfolio Value' : 'Cash Balance'} Over Time
                </h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setPortfolioChartMode('TOTAL')}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 6,
                      border: portfolioChartMode === 'TOTAL' ? '2px solid #a78bfa' : '1px solid #2d3748',
                      background: portfolioChartMode === 'TOTAL' ? '#1e1b4b' : '#0b1220',
                      color: portfolioChartMode === 'TOTAL' ? '#a78bfa' : '#9aa4b2',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                  >
                    Total Value
                  </button>
                  <button
                    onClick={() => setPortfolioChartMode('CASH')}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 6,
                      border: portfolioChartMode === 'CASH' ? '2px solid #34d399' : '1px solid #2d3748',
                      background: portfolioChartMode === 'CASH' ? '#064e3b' : '#0b1220',
                      color: portfolioChartMode === 'CASH' ? '#34d399' : '#9aa4b2',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                  >
                    Cash Only
                  </button>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={400}>
                <ComposedChart data={filteredPortfolioSeries} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
                  <XAxis dataKey="dateMs" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => new Date(v).toLocaleDateString(undefined, { year: '2-digit', month: 'short' })} tick={{ fill: '#9aa4b2', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#9aa4b2', fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(0)}`} width={72} />
                  <Tooltip 
                    contentStyle={{ background: '#1a1f2e', border: '1px solid #2d3748', borderRadius: 8 }}
                    labelFormatter={(v: number) => new Date(v).toLocaleDateString()}
                    formatter={(value: number) => [`$${value.toFixed(2)}`, '']}
                  />
                  <Legend verticalAlign="top" height={32} wrapperStyle={{ color: '#9aa4b2' }} />
                  {portfolioChartMode === 'TOTAL' ? (
                    <Line dataKey="total" name="Total Portfolio Value" stroke="#a78bfa" strokeWidth={3} dot={false} isAnimationActive={false} />
                  ) : (
                    <Line dataKey="cash" name="Cash Balance" stroke="#34d399" strokeWidth={3} dot={false} isAnimationActive={false} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Holdings Breakdown and Activity Charts */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
              {/* Holdings Breakdown */}
              <div className="chart-card">
                <div className="chart-header">
                  <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#e6e8f0' }}>📦 Current Holdings</h3>
                </div>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={holdingsBreakdown} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
                    <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
                    <XAxis dataKey="ticker" tick={{ fill: '#9aa4b2', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#9aa4b2', fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(0)}`} width={60} />
                    <Tooltip 
                      contentStyle={{ background: '#1a1f2e', border: '1px solid #2d3748', borderRadius: 8 }}
                      formatter={(value: number, name: string) => {
                        if (name === 'value') return [`$${value.toFixed(2)}`, 'Value']
                        return [value, name]
                      }}
                    />
                    <Bar dataKey="value" fill="#60a5fa" />
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ padding: '8px 16px' }}>
                  {holdingsBreakdown.map(h => (
                    <div key={h.ticker} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 14, color: '#d1d5db' }}>
                      <span>{h.ticker}: {h.shares.toFixed(3)} shares</span>
                      <span style={{ fontWeight: 600 }}>${h.value.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Transaction Activity */}
              <div className="chart-card">
                <div className="chart-header">
                  <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#e6e8f0' }}>📅 Transaction Volume (Last 24 Months)</h3>
                </div>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={transactionActivity} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
                    <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: '#9aa4b2', fontSize: 10 }} angle={-45} textAnchor="end" height={60} />
                    <YAxis tick={{ fill: '#9aa4b2', fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(0)}`} width={60} />
                    <Tooltip 
                      contentStyle={{ background: '#1a1f2e', border: '1px solid #2d3748', borderRadius: 8 }}
                      formatter={(value: number, name: string) => {
                        if (name === 'netCash') return [`$${value.toFixed(2)}`, 'Net Cash']
                        if (name === 'buys') return [`$${value.toFixed(2)}`, 'Buy Volume']
                        if (name === 'sells') return [`$${value.toFixed(2)}`, 'Sell Volume']
                        return [value, name]
                      }}
                    />
                    <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="buys" fill="#10b981" name="Buy Volume" />
                    <Bar dataKey="sells" fill="#ef4444" name="Sell Volume" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Monthly Transfers Chart */}
            {monthlyTransfers.length > 0 && (
              <div className="chart-card" style={{ marginTop: 16 }}>
                <div className="chart-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#e6e8f0' }}>
                      💸 {transfersCumulative ? 'Cumulative' : 'Monthly'} Transfers
                    </h3>
                    <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: '#9aa4b2' }}>Cash movements not from trading</p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* Time Range Selector */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      {([
                        { key: 'ALL', label: 'All' },
                        { key: '5Y', label: '5y' },
                        { key: '3Y', label: '3y' },
                        { key: '1Y', label: '1y' },
                        { key: 'YTD', label: 'YTD' },
                      ] as const).map(btn => (
                        <button
                          key={btn.key}
                          onClick={() => setTransfersRange(btn.key)}
                          style={{
                            padding: '4px 8px',
                            borderRadius: 4,
                            border: transfersRange === btn.key ? '1px solid #60a5fa' : '1px solid #2d3748',
                            background: transfersRange === btn.key ? '#1e3a8a' : '#0b1220',
                            color: transfersRange === btn.key ? '#60a5fa' : '#9aa4b2',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                          }}
                        >
                          {btn.label}
                        </button>
                      ))}
                    </div>
                    {/* Cumulative Toggle */}
                    <button
                      onClick={() => setTransfersCumulative(!transfersCumulative)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: 4,
                        border: transfersCumulative ? '1px solid #10b981' : '1px solid #2d3748',
                        background: transfersCumulative ? '#064e3b' : '#0b1220',
                        color: transfersCumulative ? '#10b981' : '#9aa4b2',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                      }}
                    >
                      {transfersCumulative ? '✓ Cumulative' : 'Monthly'}
                    </button>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={300}>
                  {transfersCumulative ? (
                    <ComposedChart data={monthlyTransfers} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                      <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
                      <XAxis dataKey="month" tick={{ fill: '#9aa4b2', fontSize: 10 }} angle={-45} textAnchor="end" height={60} />
                      <YAxis tick={{ fill: '#9aa4b2', fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(0)}`} width={60} />
                      <Tooltip 
                        contentStyle={{ background: '#1a1f2e', border: '1px solid #2d3748', borderRadius: 8 }}
                        formatter={(value: number) => [`$${value.toFixed(2)}`, 'Cumulative']}
                      />
                      <Line dataKey="transfer" name="Cumulative Transfers" stroke="#3b82f6" strokeWidth={3} dot={{ fill: '#3b82f6', r: 3 }} isAnimationActive={false} />
                    </ComposedChart>
                  ) : (
                    <BarChart data={monthlyTransfers} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                      <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
                      <XAxis dataKey="month" tick={{ fill: '#9aa4b2', fontSize: 10 }} angle={-45} textAnchor="end" height={60} />
                      <YAxis tick={{ fill: '#9aa4b2', fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(0)}`} width={60} />
                      <Tooltip 
                        contentStyle={{ background: '#1a1f2e', border: '1px solid #2d3748', borderRadius: 8 }}
                        formatter={(value: number) => [`$${value.toFixed(2)}`, 'Transfer']}
                      />
                      <Bar dataKey="transfer" name="Transfer Amount">
                        {monthlyTransfers.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.transfer >= 0 ? '#3b82f6' : '#f87171'} />
                        ))}
                      </Bar>
                    </BarChart>
                  )}
                </ResponsiveContainer>
              </div>
            )}

            {/* Monthly Stock Activity */}
            {monthlyStockActivity.length > 0 && (
              <div className="chart-card" style={{ marginTop: 16 }}>
                <div className="chart-header">
                  <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#e6e8f0' }}>📊 Monthly Stock Activity (Last 12 Months)</h3>
                </div>
                <div style={{ padding: '16px' }}>
                  {monthlyStockActivity.map((monthData) => (
                    <div key={monthData.month} style={{ marginBottom: 24, borderBottom: '1px solid #2d3748', paddingBottom: 16 }}>
                      <h4 style={{ 
                        margin: '0 0 12px 0', 
                        fontSize: '1rem', 
                        color: '#e6e8f0',
                        fontWeight: 600
                      }}>
                        {new Date(monthData.month + '-01').toLocaleDateString('en-US', { 
                          year: 'numeric', 
                          month: 'long' 
                        })}
                      </h4>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                        {monthData.stocks.map((stock) => (
                          <div key={stock.stock} style={{
                            backgroundColor: '#1a1f2e',
                            border: '1px solid #2d3748',
                            borderRadius: 8,
                            padding: 12
                          }}>
                            <div style={{ 
                              fontSize: '14px', 
                              fontWeight: 600, 
                              color: '#e6e8f0',
                              marginBottom: 8
                            }}>
                              {stock.stock}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                              <span style={{ fontSize: '12px', color: '#9aa4b2' }}>Buys:</span>
                              <span style={{ 
                                fontSize: '12px', 
                                color: '#10b981',
                                fontWeight: 600
                              }}>
                                ${stock.buys.toFixed(2)}
                              </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ fontSize: '12px', color: '#9aa4b2' }}>Sells:</span>
                              <span style={{ 
                                fontSize: '12px', 
                                color: '#ef4444',
                                fontWeight: 600
                              }}>
                                ${stock.sells.toFixed(2)}
                              </span>
                            </div>
                            <div style={{ 
                              display: 'flex', 
                              justifyContent: 'space-between',
                              marginTop: 8,
                              paddingTop: 8,
                              borderTop: '1px solid #2d3748'
                            }}>
                              <span style={{ fontSize: '12px', color: '#9aa4b2', fontWeight: 600 }}>Net:</span>
                              <span style={{ 
                                fontSize: '12px', 
                                color: (stock.buys - stock.sells) >= 0 ? '#10b981' : '#ef4444',
                                fontWeight: 600
                              }}>
                                ${(stock.buys - stock.sells).toFixed(2)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === 'TICKER' && (
        <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
        <p className="note">Data source: <code>public/stock-values.csv</code></p>
        {selectedTransactions.length > 0 && (
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', fontSize: '14px', color: '#9aa4b2' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ 
                width: 0, 
                height: 0, 
                borderLeft: '6px solid transparent',
                borderRight: '6px solid transparent',
                borderBottom: '10px solid #10b981'
              }}></div>
              <span>Buy</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ 
                width: 0, 
                height: 0, 
                borderLeft: '6px solid transparent',
                borderRight: '6px solid transparent',
                borderTop: '10px solid #ef4444'
              }}></div>
              <span>Sell</span>
            </div>
          </div>
        )}
      </div>

      {/* Summary metrics */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-label">Shares Held</div>
          <div className="metric-value">{metrics.sharesHeld.toFixed(2)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Avg Cost / Share</div>
          <div className="metric-value">${metrics.avgCostPerShare.toFixed(2)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Total Cost Basis</div>
          <div className="metric-value">${metrics.totalCostBasis.toFixed(2)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Market Value</div>
          <div className="metric-value">${metrics.marketValue.toFixed(2)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Unrealized Gain</div>
          <div className={`metric-value ${metrics.unrealizedGain >= 0 ? 'pos' : 'neg'}`}>{metrics.unrealizedGain >= 0 ? '+' : ''}${metrics.unrealizedGain.toFixed(2)} ({metrics.unrealizedGainPct.toFixed(2)}%)</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Realized Gain</div>
          <div className={`metric-value ${metrics.realizedGainTotal >= 0 ? 'pos' : 'neg'}`}>{metrics.realizedGainTotal >= 0 ? '+' : ''}${metrics.realizedGainTotal.toFixed(2)} ({metrics.realizedGainTotalPct.toFixed(2)}%)</div>
        </div>
      </div>

      {/* Transactions table */}
      {selectedTransactions.length > 0 && (
        <div className="transactions-card">
          <h3 className="transactions-title">
            {selectedTicker} Transactions
            <span style={{ marginLeft: 12, fontWeight: 500, color: '#9aa4b2' }}>
              Realized Gain: <span className={metrics.realizedGainTotal >= 0 ? 'pos' : 'neg'}>{metrics.realizedGainTotal >= 0 ? '+' : ''}${Math.abs(metrics.realizedGainTotal).toFixed(2)}</span>
            </span>
          </h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Cost</th>
                  <th>Gain/Loss %</th>
                  <th>Gain/Loss $</th>
                  <th>Cost Basis / Share</th>
                </tr>
              </thead>
              <tbody>
                {selectedTransactionsSortedDesc.map((t) => {
                  const isBuy = t.type === 'Buy'
                  const cost = isBuy
                    ? (t.quantity * t.pricePerShare + t.commission + t.fees)
                    : (t.quantity * t.pricePerShare - t.commission - t.fees)
                  const costBasisPerShare = t.quantity > 0
                    ? (t.quantity * t.pricePerShare + (isBuy ? (t.commission + t.fees) : 0)) / t.quantity
                    : undefined
                  // Gains for buys are vs current price; for sells, vs overall average buy price
                  const sellBenchmark = metrics.avgCostPerShare
                  const gainDollar = isBuy && costBasisPerShare
                    ? (metrics.lastPrice - costBasisPerShare) * t.quantity
                    : (!isBuy && sellBenchmark > 0
                        ? (t.pricePerShare - sellBenchmark) * t.quantity
                        : undefined)
                  const gainPct = isBuy && costBasisPerShare && costBasisPerShare > 0
                    ? ((metrics.lastPrice / costBasisPerShare) - 1) * 100
                    : (!isBuy && sellBenchmark > 0
                        ? ((t.pricePerShare / sellBenchmark) - 1) * 100
                        : undefined)
                  return (
                    <tr key={`${t.symbol}-${t.dateMs}-${t.type}-${t.quantity}-${t.pricePerShare}-${t.commission}-${t.fees}`}>
                    <td>{new Date(t.dateMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })}</td>
                    <td>
                      <span className={`pill ${t.type === 'Buy' ? 'buy' : 'sell'}`}>{t.type}</span>
                    </td>
                      <td>${Math.abs(cost).toFixed(2)}</td>
                      <td>
                        {gainPct == null ? '—' : (
                          <span className={`gain-chip ${gainDollar !== undefined && gainDollar >= 0 ? 'gl-pos' : 'gl-neg'}`}>
                            {gainDollar !== undefined && gainDollar >= 0 ? '+' : ''}{gainPct.toFixed(2)}%
                          </span>
                        )}
                      </td>
                      <td>
                        {gainDollar == null ? '—' : (
                          <span className={`gain-chip ${gainDollar >= 0 ? 'gl-pos' : 'gl-neg'}`}>
                            {gainDollar >= 0 ? '+' : ''}${Math.abs(gainDollar).toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td>{costBasisPerShare == null ? '—' : `$${costBasisPerShare.toFixed(2)}`}</td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  )
}

export default App
