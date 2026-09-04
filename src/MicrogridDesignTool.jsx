import React, { useState, useMemo, useRef, useEffect, useContext, createContext } from "react";
import Papa from "papaparse";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, ComposedChart,
  ScatterChart, Scatter, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";
import * as XLSX from "xlsx";
import {
  LOCATION_LIBRARY, MARKET_PRICES_2025, VRE_PENETRATION_2025,
  DEMAND_MONTHLY_INDEX, DEMAND_HOURLY_INDEX,
} from "./data/library-2025.js";
import { EXAMPLE_PROJECTS } from "./data/examples.js";
export { LOCATION_LIBRARY, MARKET_PRICES_2025, VRE_PENETRATION_2025 };

/* ============================================================================
   MICROGRID DESIGN TOOL — PHASE 1
   Project context · Location & resource library · Load input · AIDC derivation

   ALL physical and cost coefficients live in this block. Nothing numeric is
   buried in a function below. Units are stated on every single entry.
   ========================================================================== */

/* Release identity, shown in the footer and written into every saved project
   file so a result can always be traced back to the build that produced it. */
export const TOOL_RELEASE = {
  version: "1.2.0",
  date: "2026-09-04",
  author: "Xavier Becuwe",
};

export const CONSTANTS = {
  /* --- Time base -------------------------------------------------------- */
  HOURS_PER_YEAR: 8760,                 // h/yr   non-leap reference year
  REFERENCE_YEAR: 2027,                 // -      non-leap; fixes weekday pattern
  DAYS_PER_MONTH: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], // d

  /* --- Solar geometry & clear-sky model ---------------------------------
     Shape only. Magnitude is anchored to the location's stated specific
     yield (kWh/kWp/yr), so the model never invents a resource.            */
  SOLAR_CONSTANT_W_M2: 1361,            // W/m²   extraterrestrial normal irradiance
  CLEARSKY_ATM_TRANSMITTANCE: 0.70,     // -      broadband transmittance at AM1 (Meinel form)
  CLEARSKY_AM_EXPONENT: 0.678,          // -      air-mass exponent, ghi = E0·cosθz·τ^(AM^x)
  MIN_COS_ZENITH: 0.02,                 // -      below this the hour is treated as dark
  PV_TILT_FRACTION_OF_LAT: 0.9,         // -      assumed fixed tilt = 0.9 × |latitude|
  PV_TILT_MAX_DEG: 40,                  // °      cap on the assumed fixed tilt

  /* --- PV cell thermal behaviour (used to shape the yield profile) ------- */
  PV_NOCT_C: 45,                        // °C     nominal operating cell temp @ 800 W/m², 20 °C
  PV_NOCT_IRRADIANCE_W_M2: 800,         // W/m²   reference irradiance for NOCT
  PV_NOCT_AMBIENT_C: 20,                // °C     reference ambient for NOCT
  PV_TEMP_COEFF_PCT_PER_C: -0.35,       // %/°C   Pmp coefficient above 25 °C
  PV_REF_TEMP_C: 25,                    // °C     STC cell temperature

  /* --- Resource data quality -------------------------------------------- */
  LIBRARY_YIELD_UNCERTAINTY_PCT: 8,     // ±%     P50 band on a library yield vs site data
  SITE_YIELD_UNCERTAINTY_PCT: 3,        // ±%     P50 band on an uploaded TMY / measured year

  /* --- Ambient temperature synthesis ------------------------------------ */
  DIURNAL_PEAK_HOUR: 15,                // h      hour of day of the daily temperature maximum

  /* --- AIDC: cooling system behaviour -----------------------------------
     designPUE     : default total PUE at the site design ambient
     freeCoolingBelowC : dry-bulb at or below which the plant is on economiser only
     designAmbientC: dry-bulb at which the design PUE is quoted
     minCoolingFrac: cooling power at full free cooling, as a fraction of design
                     cooling power (fans / pumps still run)
     overloadCap   : max cooling power above design ambient, fraction of design  */
  COOLING: {
    air:       { designPUE: 1.35, freeCoolingBelowC: 18, designAmbientC: 35, minCoolingFrac: 0.25, overloadCap: 1.15, label: "Air cooled (CRAH / economiser)" },
    liquid:    { designPUE: 1.20, freeCoolingBelowC: 22, designAmbientC: 35, minCoolingFrac: 0.18, overloadCap: 1.12, label: "Direct-to-chip liquid" },
    immersion: { designPUE: 1.10, freeCoolingBelowC: 30, designAmbientC: 40, minCoolingFrac: 0.10, overloadCap: 1.08, label: "Immersion" },
  },
  PUE_CLIMATE_ADDER_PER_C: 0.006,       // PUE/°C  added per °C of annual mean above 12 °C reference
  PUE_CLIMATE_REF_TEMP_C: 12,           // °C      reference annual mean for the adder
  PUE_CLIMATE_ADDER_MAX: 0.15,          // PUE     cap on the climate adder

  /* --- AIDC: non-cooling overhead (all as % of IT load) ------------------ */
  UPS_LOSS_PCT_OF_IT: 2.5,              // %       double-conversion UPS losses at part load
  DISTRIBUTION_LOSS_PCT_OF_IT: 1.5,     // %       transformers, switchgear, busway
  MISC_LOAD_PCT_OF_IT: 1.0,             // %       lighting, controls, security, offices

  /* --- AIDC: criticality and dynamics ----------------------------------- */
  IT_UTILISATION_PCT_DEFAULT: 85,       // %       mean IT draw vs installed IT capacity
  LIQUID_RACK_THERMAL_MARGIN_S: 15,     // s       time to thermal trip at high density with no flow
  AIR_RACK_THERMAL_MARGIN_S: 120,       // s       equivalent for a conventional air-cooled hall
  ANTI_RECYCLE_TIMER_MIN_DEFAULT: 10,   // min     chiller restart lockout after a stop
  LOAD_SWING_PCT_DEFAULT: 30,           // % of IT collective compute swing (training job start/stop)
  LOAD_SWING_SECONDS_DEFAULT: 2,        // s       timescale over which that swing occurs

  /* --- AIDC: redundancy → firm capacity requirement ---------------------- */
  REDUNDANCY: {
    N:      { firmFactor: 1.00, spareUnits: 0, label: "N (no redundancy)" },
    NPLUS1: { firmFactor: 1.00, spareUnits: 1, label: "N+1 (one spare unit)" },
    TWON:   { firmFactor: 2.00, spareUnits: 0, label: "2N (two independent paths)" },
  },

  /* --- Land and footprint ------------------------------------------------ */
  PV_AREA_M2_PER_KWP: 12,               // m²/kWp  ground-mount incl. row spacing, mid-latitude
  PV_AREA_M2_PER_KWP_ROOF: 7,           // m²/kWp  flat-roof ballasted
  BESS_FOOTPRINT_M2_PER_MW: 120,        // m²/MW   containerised, incl. access and separation
  ENGINE_FOOTPRINT_M2_PER_MW: 90,       // m²/MW   containerised gensets incl. radiators
  M2_PER_HA: 10000,                     // m²/ha

  /* --- Load synthesis ---------------------------------------------------- */
  SHAPE_GAMMA_MIN: 0.05,                // -       lower bound of the shape exponent search
  SHAPE_GAMMA_MAX: 25,                  // -       upper bound of the shape exponent search
  SHAPE_GAMMA_TOL_MWH: 0.05,            // MWh     bisection tolerance on annual energy

  /* --- PV plant (Phase 2) ------------------------------------------------ */
  PV_DCAC_RATIO_DEFAULT: 1.25,          // -       DC kWp per AC kW of inverter
  PV_SOILING_PCT: 2,                    // %       annual average soiling loss
  PV_BIFACIAL_GAIN_PCT: 0,              // %       rear-side gain, 0 for monofacial
  PV_DEGRADATION_PCT_PER_YR: 0.5,       // %/yr    linear power degradation
  PV_AVAILABILITY_PCT: 99,              // %       plant availability
  PV_OTHER_LOSSES_PCT: 6,               // %       wiring, mismatch, inverter, transformer

  /* --- Wind plant (Phase 2) ---------------------------------------------
     Hourly wind speed is synthesised from the site Weibull distribution with
     an AR(1) memory so that calm and windy spells persist realistically. The
     sequence is seeded, so the same site always produces the same year.      */
  WIND_SHEAR_EXPONENT: 0.14,            // -       power-law shear, open terrain
  WIND_REFERENCE_HEIGHT_M: 100,         // m       height of the library mean speed
  WIND_AR1_RHO: 0.88,                   // -       hour-to-hour autocorrelation
  WIND_SEASONAL_AMPLITUDE: 0.15,        // ±       fraction, peak in mid-January
  WIND_SEASON_PEAK_DOY: 15,             // d       day of year of the windiest period
  WIND_RANDOM_SEED: 20260810,           // -       fixes the synthetic year
  WIND_CUT_IN_M_S: 3,                   // m/s
  WIND_RATED_M_S: 12,                   // m/s
  WIND_CUT_OUT_M_S: 25,                 // m/s
  WIND_AVAILABILITY_PCT: 96,            // %
  WIND_WAKE_AND_ARRAY_LOSS_PCT: 5,      // %       wake, electrical, blade soiling
  AIR_DENSITY_REF_KG_M3: 1.225,         // kg/m³   ISO standard air
  AIR_GAS_CONSTANT_J_KG_K: 287.05,      // J/(kg·K)
  AIR_PRESSURE_PA: 101325,              // Pa      sea-level, altitude ignored

  /* --- BESS (Phase 2) ---------------------------------------------------- */
  BESS_RTE_PCT: 88,                     // %       round-trip AC–AC including PCS
  BESS_SOC_MIN_PCT: 5,                  // %       bottom of the usable window
  BESS_SOC_MAX_PCT: 95,                 // %       top of the usable window
  BESS_RESERVE_SOC_PCT: 30,             // %       held for resilience — hard constraint
  BESS_AUX_PCT_OF_RATING: 1.0,          // %       HVAC and controls, of rated power
  BESS_C_RATE: 0.5,                     // 1/h     max power ÷ energy
  BESS_CALENDAR_FADE_PCT_PER_YR: 1.5,   // %/yr    capacity loss, calendar
  BESS_CYCLE_FADE_PCT_PER_EFC: 0.0035,  // %/EFC   capacity loss per equivalent full cycle
  BESS_GRID_FORMING_STEP_PCT: 50,       // %       of rating, instantaneous load step capability

  /* --- Reciprocating engines (Phase 2) -----------------------------------
     Specific fuel consumption is quoted at 25/50/75/100 % load and
     interpolated linearly between those points. Part-load efficiency
     collapse is the whole reason minimum stable load matters.               */
  ENGINE_MIN_STABLE_LOAD_PCT: 35,       // %       of unit rating
  ENGINE_STEP_ACCEPTANCE_PCT: 25,       // %       of unit rating, single load step
  ENGINE_START_TIME_MIN_DIESEL: 0.5,    // min     standby diesel, off to on load
  ENGINE_START_TIME_MIN_GAS: 5,         // min     gas reciprocating engine
  ENGINE_MIN_UP_TIME_H: 1,              // h
  ENGINE_MIN_DOWN_TIME_H: 1,            // h
  ENGINE_DERATE_PCT_PER_C_ABOVE_25: 0.5,// %/°C    site derating above 25 °C
  DIESEL_SFC_L_PER_KWH: [0.36, 0.29, 0.27, 0.28],  // l/kWh at 25/50/75/100 % load
  GAS_ENGINE_EFF_PCT: [32, 38, 41, 42], // %       electrical efficiency at 25/50/75/100 %
  ENGINE_LOAD_POINTS_PCT: [25, 50, 75, 100], // %  load points for both curves above
  /* Economic running. When it is switched on, the engine is offered ahead of
     grid import in any hour where its short-run marginal cost is below the
     import price by this margin. The margin exists so a near-tie does not
     start and stop the fleet hour after hour. */
  ENGINE_ECONOMIC_START_MARGIN: 1.05,   // -       import price must exceed engine marginal cost by this factor
  ENGINE_ECONOMIC_LOAD_POINT_PCT: 90,   // %       load point at which the marginal cost is evaluated

  /* --- Gas turbine (Phase 2) --------------------------------------------- */
  TURBINE_MIN_LOAD_PCT: 50,             // %       of site rating
  TURBINE_EFF_PCT: [24, 30, 34, 36],    // %       electrical efficiency at 25/50/75/100 %
  TURBINE_START_TIME_MIN: 10,           // min
  TURBINE_DERATE_PCT_PER_C_ABOVE_15: 0.7, // %/°C  ambient derating, above ISO 15 °C
  TURBINE_MIN_UP_TIME_H: 4,             // h
  TURBINE_MIN_DOWN_TIME_H: 2,           // h

  /* --- Tariff (Phase 2) --------------------------------------------------- */
  TOU_PEAK_START_HOUR: 8,               // h       local, weekdays only
  TOU_PEAK_END_HOUR: 20,                // h
  TOU_PEAK_MULTIPLIER: 1.5,             // ×       of the base import tariff
  TOU_OFFPEAK_MULTIPLIER: 0.6,          // ×       of the base import tariff
  ARBITRAGE_CHARGE_THRESHOLD: 0.8,      // ×       charge from grid below this × mean price

  /* --- Price formation ----------------------------------------------------
     Wholesale price follows RESIDUAL demand — national demand less what wind
     and solar are producing at that moment — through a convex supply curve.
     The solar term uses the same irradiance series that drives the site's own
     PV, so a sunny hour is a cheap hour in the same model run. Decoupling the
     two would value both self-consumption and arbitrage wrongly.            */
  PRICE_RESIDUAL_ELASTICITY: 2.2,       // -   price index = (residual / mean residual) ^ this
  PRICE_DAMPING: 0.35,                  // -   interconnection, hydro and flexible plant damp both
                                        //     tails; without it the synthetic curve is about twice
                                        //     as volatile as the real 2025 day-ahead series
  PRICE_CAP_MULTIPLE: 5.0,              // -   ceiling on the index, so scarcity does not run away
  PRICE_NEGATIVE_HOUR_SHARE: 0.06,      // -   share of hours that clear below zero. In 2025 France,
                                        //     Germany, the Netherlands and Spain all reached about 6 %
                                        //     (IEA Electricity 2026); the threshold is set at that
                                        //     percentile of residual demand rather than a fixed level,
                                        //     because it is must-run inflexibility that sets it.
  PRICE_NEGATIVE_DEPTH: 0.6,           // -   index units subtracted as residual falls to zero

  /* --- Optimised dispatch (dynamic programming) --------------------------
     The optimiser searches over a discretised state of charge. More levels
     means a finer answer and a slower run; 41 is accurate to well under a
     percent of annual cost on every case tested here.                       */
  OPT_SOC_LEVELS: 41,                   // -       state-of-charge steps in the search
  OPT_SOC_LEVELS_MIN: 11,               // -       below this the discretisation is too coarse to mean anything
  OPT_SOC_LEVELS_MAX: 121,              // -       policy is an Int8Array, so a level change must stay inside ±127
  OPT_CEILING_STEPS: [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6], // - import ceilings tried
  BESS_WEAR_COST_EUR_PER_MWH: 4,        // €/MWh   throughput cost, so the optimiser will not
                                        //         cycle the battery for a gain smaller than
                                        //         the degradation it causes
  VALUE_OF_LOST_LOAD_EUR_PER_MWH: 5000, // €/MWh   cost the optimiser puts on unserved energy

  /* --- Dispatch look-ahead -----------------------------------------------
     Pure merit order is myopic: it discharges into the first peak it meets and
     charges on a static price threshold. These rules give it a finite horizon
     without turning it into an optimiser — each is a single sentence and each
     leaves its own reason code in the hourly table.                          */
  LOOKAHEAD_HOURS: 24,                  // h       forecast horizon used by the rules below
  LOOKAHEAD_CHEAP_FRACTION: 0.25,       // -       charge only in the cheapest quarter of the horizon
  LOOKAHEAD_BISECTION_STEPS: 40,        // -       iterations for the peak-levelling water-fill

  /* --- Adequacy assessment (Phase 3) -------------------------------------
     Dynamic adequacy is assessed in island mode, because that is the condition
     in which the microgrid has to survive a step on its own inertia.          */
  NOMINAL_FREQUENCY_HZ: 50,             // Hz
  INERTIA_H_ENGINE_S: 1.5,              // s       inertia constant of a genset, on its own MVA base
  INERTIA_H_TURBINE_S: 5.0,             // s       aeroderivative gas turbine
  GENERATOR_POWER_FACTOR: 0.9,          // -       kW → kVA for the inertia base
  GOVERNOR_RESPONSE_TIME_S: 1.5,        // s       time to arrest frequency with fuel valve response
  ROCOF_PASS_HZ_PER_S: 1.0,             // Hz/s    below this the step is comfortable
  ROCOF_MARGINAL_HZ_PER_S: 2.0,         // Hz/s    typical loss-of-mains protection setting
  FREQ_NADIR_PASS_HZ: 1.0,              // Hz      ±2 % of 50 Hz
  FREQ_NADIR_MARGINAL_HZ: 2.0,          // Hz      ±4 %, beyond which load shedding is expected
  MOTOR_INRUSH_FACTOR: { DOL: 6.0, SOFT: 3.0, VSD: 1.1 }, // × rated kW, starting current as apparent power
  UNSERVED_ENERGY_TOLERANCE_PCT: 0.01,  // %       of annual load treated as a pass
  LOW_RENEWABLE_WINDOW_H: 72,           // h       window used to find the worst renewable spell
  N_MINUS_1_MARGIN_PCT: 0,              // %       required headroom after losing the largest unit

  /* --- Cost defaults library (EUR, EU markets) — surfaced in Phase 4 -----
     Held here so that every coefficient in the tool sits in one place.     */
  COST_DEFAULTS: {
    PV_EUR_PER_KWP: 650,                // €/kWp   ground-mount, EPC, ex-grid connection
    BESS_EUR_PER_KW: 180,               // €/kW    power conversion system
    BESS_EUR_PER_KWH: 190,              // €/kWh   LFP cells + enclosure + HVAC
    BESS_GRID_FORMING_ADDER_EUR_PER_KW: 25, // €/kW additional for grid-forming capability
    ENGINE_DIESEL_EUR_PER_KW: 420,      // €/kW    containerised genset, installed
    ENGINE_GAS_EUR_PER_KW: 780,         // €/kW    gas reciprocating engine, installed
    TURBINE_EUR_PER_KW: 950,            // €/kW    aeroderivative gas turbine, installed
    WIND_EUR_PER_KW: 1350,              // €/kW    onshore, installed
    GRID_CONNECTION_EUR_PER_KW: 120,    // €/kW    typical HV connection charge, EU average
    OM_PV_EUR_PER_KWP_YR: 12,           // €/kWp/yr
    OM_BESS_PCT_CAPEX_YR: 1.5,          // %/yr    of BESS capex
    OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW: 9, // €/MW/running hour
    OM_WIND_EUR_PER_KW_YR: 38,          // €/kW/yr
    BESS_AUGMENTATION_EUR_PER_KWH: 110, // €/kWh   at augmentation year, real terms
    AUGMENTATION_YEARS: "10",           // -       comma-separated years for BESS augmentation
    EXPORT_PRICE_EUR_PER_MWH: 40,       // €/MWh   value of exported surplus
    // Balance of plant as a function of quantities — never a flat percentage
    BOP_EUR_PER_MWP_PV: 45000,          // €/MWp   trackers/racking interface, DC collection, civils
    BOP_EUR_PER_MW_BESS: 60000,         // €/MW    AC collection, transformer, protection
    BOP_EUR_PER_MWH_BESS: 8000,         // €/MWh   containers, fire suppression, HVAC interface
    BOP_EUR_PER_MW_THERMAL: 55000,      // €/MW    fuel system, exhaust, acoustic treatment
    BOP_EUR_PER_MW_SWITCHGEAR: 35000,   // €/MW    MV switchgear and cabling, all sources
    BOP_FIXED_EUR: 250000,              // €       site establishment, control room, EMS, commissioning
    DIESEL_KWH_PER_LITRE: 10.0,         // kWh_th/l  lower heating value of diesel
    CO2_KG_PER_LITRE_DIESEL: 2.68,      // kgCO2/l
    CO2_KG_PER_MWH_GAS: 202,            // kgCO2/MWh_th  natural gas combustion
  },

  /* Guided auto-size — every coefficient of the search-space proposal and the
     refinement, so a proposed range is always traceable to a number here. */
  AUTOSIZE: {
    PV_OVERBUILD_MAX: 1.5,              // × load-match kWp   upper bound of the PV axis unless land binds first
    PV_COARSE_LEVELS: [0, 0.5, 1.0, 1.5], // × search scale    PV sizes tested in the coarse pass, clipped to the bound
    WIND_COARSE_LEVELS: [0, 0.5, 1.0],  // × load-match MW    wind sizes tested in the coarse pass
    WIND_SCREEN_MARGIN: 1.0,            // -    wind enters the search when its standalone LCOE is below margin × delivered grid price
    SURPLUS_POWER_QUANTILE: 0.95,       // -    quantile of hourly PV surplus used as the storage power anchor
    SHAVE_QUANTILE: 0.90,               // -    load-duration quantile; peak minus this is the peak-shaving anchor
    BESS_FALLBACK_PEAK_FRACTION: 0.25,  // × peak kW          arbitrage starting size when no other anchor exists
    BESS_DURATIONS_H: [2, 4],           // h    storage durations tested in the coarse pass
    BESS_DURATION_LADDER_H: [1, 2, 4, 6], // h  neighbouring durations tested in refinement
    REFINE_STEP_PCT: 25,                // %    one-axis step around the leading design in refinement
    REFINE_STEP_MIN_PCT: 10,            // %    refinement stops once step-halving would go below this
    REFINE_ROUNDS: 6,                   // -    maximum coordinate-refinement rounds; stops early once the leader survives its neighbours
    OPT_SHORTLIST: 6,                   // -    designs re-priced under optimisation after merit-order screening
    MAX_CANDIDATES: 500,                // -    hard cap on designs evaluated in one search
    ENGINE_PEAK_FRACTIONS: [0.25, 0.5, 1.0], // × peak kW   generator fleet sizes tested when no firm shortfall
                                        //      exists and generation is included in the search anyway
    ENGINE_MAX_HEADROOM: 1.1,           // × units needed to cover peak + auxiliaries — nothing beyond
                                        //      this can ever be dispatched, so nothing beyond it is tested
  },

  /* Dispatch calibration — forecast-error stress and battery duty audit.
     The stress is a stated, reproducible perturbation of the simulated year,
     not a weather model: day-level errors are correlated within the day, the
     seed is fixed so two runs give the same answer, and every magnitude is
     visible here. */
  HOURLY_MATCH_THRESHOLD_PCT: 80,       // %  share of each hour's consumption to be backed by renewables
                                        //    (Spain, draft royal decree of 25 August 2026, data centres >= 1 MW)

  CALIBRATION: {
    PV_DAY_ERROR_PCT: 15,           // %    day-ahead PV energy error, one sigma, applied per day
    WIND_DAY_ERROR_PCT: 20,         // %    day-ahead wind energy error, one sigma, applied per day
    LOAD_DAY_ERROR_PCT: 3,          // %    day-ahead load error, one sigma, applied per day
    PRICE_DAY_ERROR_PCT: 15,        // % of mean |price|   day-level price level error, one sigma
    PRICE_HOUR_ERROR_PCT: 8,        // % of mean |price|   within-day price shape error, one sigma
    ERROR_CLAMP_SIGMA: 3,           // -    all draws clamped at this many sigma
    SEED: 20260817,                 // -    fixed PRNG seed — the stress is reproducible run to run
    WARRANTY_CYCLES: 6000,          // -    cycle life to end of warranty, counted as nameplate equivalent full cycles
    WARRANTY_YEARS: 15,             // yr   calendar term of the warranty
    WEAR_UNDERPRICE_FACTOR: 0.5,    // -    warn when the steering wear cost is below this share of full amortisation AND the cycle budget is exceeded
  },
};

export const LOAD_SHAPES = {
  continuous: {
    label: "Continuous 24/7 process",
    weekday: [0.90,0.90,0.89,0.89,0.90,0.92,0.95,0.98,1.00,1.00,1.00,1.00,0.99,0.99,1.00,1.00,0.99,0.97,0.95,0.94,0.93,0.92,0.91,0.90],
    weekend: [0.88,0.88,0.87,0.87,0.88,0.89,0.91,0.93,0.95,0.96,0.96,0.96,0.95,0.95,0.95,0.95,0.94,0.93,0.92,0.91,0.90,0.89,0.89,0.88],
  },
  datacentre: {
    label: "Data centre (flat)",
    weekday: [0.96,0.96,0.95,0.95,0.95,0.96,0.97,0.98,0.99,1.00,1.00,1.00,1.00,1.00,1.00,1.00,0.99,0.99,0.98,0.98,0.97,0.97,0.96,0.96],
    weekend: [0.95,0.95,0.94,0.94,0.94,0.95,0.96,0.97,0.98,0.98,0.99,0.99,0.99,0.99,0.99,0.98,0.98,0.98,0.97,0.97,0.96,0.96,0.95,0.95],
  },
  single_shift: {
    label: "Single shift (06:00–14:00)",
    weekday: [0.08,0.08,0.08,0.08,0.10,0.35,0.75,0.95,1.00,1.00,0.98,0.98,0.95,0.90,0.60,0.20,0.12,0.10,0.09,0.08,0.08,0.08,0.08,0.08],
    weekend: [0.08,0.08,0.08,0.08,0.08,0.09,0.10,0.12,0.14,0.14,0.14,0.14,0.13,0.12,0.11,0.10,0.09,0.09,0.08,0.08,0.08,0.08,0.08,0.08],
  },
  two_shift: {
    label: "Two shift (06:00–22:00)",
    weekday: [0.18,0.17,0.17,0.17,0.20,0.45,0.85,1.00,1.00,0.98,0.97,0.95,0.88,0.92,0.97,0.98,0.97,0.95,0.90,0.80,0.60,0.35,0.22,0.19],
    weekend: [0.16,0.16,0.15,0.15,0.16,0.20,0.28,0.32,0.34,0.34,0.33,0.32,0.30,0.30,0.30,0.29,0.28,0.26,0.24,0.22,0.20,0.18,0.17,0.16],
  },
  office: {
    label: "Office hours",
    weekday: [0.12,0.12,0.11,0.11,0.12,0.15,0.28,0.55,0.85,0.95,1.00,1.00,0.92,0.95,0.98,0.96,0.88,0.65,0.42,0.28,0.20,0.16,0.14,0.13],
    weekend: [0.12,0.12,0.11,0.11,0.11,0.12,0.13,0.15,0.18,0.20,0.21,0.21,0.20,0.20,0.19,0.18,0.17,0.16,0.15,0.14,0.13,0.13,0.12,0.12],
  },
  custom: {
    label: "Custom weekday / weekend",
    weekday: new Array(24).fill(0.8),
    weekend: new Array(24).fill(0.5),
  },
};

export const USE_CASE_FAMILIES = {
  resilience:   { label: "Resilience driven",            binding: "Power + dynamic adequacy in island mode", defaults: { islanding: "unplanned", autonomyH: 8,  critPct: 70 } },
  cost:         { label: "Cost / self-consumption",      binding: "Energy cost — tariff and demand charges", defaults: { islanding: "none",      autonomyH: 0,  critPct: 30 } },
  access:       { label: "Access (off-grid, island)",    binding: "Energy adequacy — unserved energy",       defaults: { islanding: "unplanned", autonomyH: 24, critPct: 90 } },
  decarb:       { label: "Decarbonisation",              binding: "Renewable fraction at acceptable LCOE",   defaults: { islanding: "none",      autonomyH: 0,  critPct: 40 } },
  deferral:     { label: "Grid connection deferral",     binding: "Firm capacity behind an import cap",      defaults: { islanding: "planned",   autonomyH: 4,  critPct: 85 } },
};

/* ============================================================================
   ENGINE — calendar, ambient temperature, solar resource, load synthesis
   ========================================================================== */

const H = CONSTANTS.HOURS_PER_YEAR;

function buildCalendar() {
  const month = new Uint8Array(H), hourOfDay = new Uint8Array(H);
  const doy = new Uint16Array(H), dow = new Uint8Array(H);
  let i = 0, day = 0;
  for (let m = 0; m < 12; m++) {
    for (let d = 0; d < CONSTANTS.DAYS_PER_MONTH[m]; d++) {
      const w = new Date(Date.UTC(CONSTANTS.REFERENCE_YEAR, m, d + 1)).getUTCDay();
      for (let h = 0; h < 24; h++) { month[i] = m; hourOfDay[i] = h; doy[i] = day; dow[i] = w; i++; }
      day++;
    }
  }
  return { month, hourOfDay, doy, dow };
}

/** Cyclic linear interpolation of 12 monthly values onto 365 days, anchored at month mid-points. */
function monthlyToDaily(monthly) {
  const mid = []; let acc = 0;
  for (let m = 0; m < 12; m++) { mid.push(acc + CONSTANTS.DAYS_PER_MONTH[m] / 2); acc += CONSTANTS.DAYS_PER_MONTH[m]; }
  const out = new Float32Array(365);
  for (let d = 0; d < 365; d++) {
    let m1 = 11, m2 = 0, f = 0;
    if (d < mid[0]) { m1 = 11; m2 = 0; f = (d + 365 - mid[11]) / (mid[0] + 365 - mid[11]); }
    else if (d >= mid[11]) { m1 = 11; m2 = 0; f = (d - mid[11]) / (mid[0] + 365 - mid[11]); }
    else { for (let m = 0; m < 11; m++) if (d >= mid[m] && d < mid[m + 1]) { m1 = m; m2 = m + 1; f = (d - mid[m]) / (mid[m + 1] - mid[m]); break; } }
    out[d] = monthly[m1] * (1 - f) + monthly[m2] * f;
  }
  return out;
}

/** Hourly dry-bulb ambient (°C): monthly mean + sinusoidal diurnal swing peaking at 15:00. */
function buildTemperature(loc, cal) {
  const daily = monthlyToDaily(loc.tempMeanC);
  const swing = loc.diurnalSwingC;
  const T = new Float32Array(H);
  const phase = (CONSTANTS.DIURNAL_PEAK_HOUR - 6) / 24 * 2 * Math.PI;
  for (let i = 0; i < H; i++) {
    T[i] = daily[cal.doy[i]] + (swing / 2) * Math.sin(2 * Math.PI * cal.hourOfDay[i] / 24 - phase);
  }
  return T;
}

/**
 * Hourly PV specific production, kW per kWp installed.
 * Shape  = clear-sky geometry × monthly clearness × cell-temperature derate.
 * Scale  = anchored so that Σ = the stated annual specific yield (kWh/kWp/yr).
 * The model therefore never claims a resource the yield figure does not support.
 */
function buildPVUnit(loc, cal, temp) {
  const raw = new Float32Array(H);
  const phi = loc.lat * Math.PI / 180;
  // Fixed, equator-facing plane. Tilting the array is equivalent to shifting the
  // effective latitude toward the equator by the tilt angle.
  const tiltDeg = Math.min(CONSTANTS.PV_TILT_MAX_DEG, Math.abs(loc.lat) * CONSTANTS.PV_TILT_FRACTION_OF_LAT);
  const phiEff = (loc.lat - Math.sign(loc.lat || 1) * tiltDeg) * Math.PI / 180;
  for (let i = 0; i < H; i++) {
    const n = cal.doy[i] + 1;
    const dec = 23.45 * Math.sin(2 * Math.PI * (284 + n) / 365) * Math.PI / 180;
    const omega = (cal.hourOfDay[i] + 0.5 - 12) * 15 * Math.PI / 180;
    const cosz = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(omega);
    if (cosz <= CONSTANTS.MIN_COS_ZENITH) { raw[i] = 0; continue; }
    const cosInc = Math.max(0, Math.sin(phiEff) * Math.sin(dec) + Math.cos(phiEff) * Math.cos(dec) * Math.cos(omega));
    const am = 1 / cosz;
    const ghi = CONSTANTS.SOLAR_CONSTANT_W_M2 * cosInc *
      Math.pow(CONSTANTS.CLEARSKY_ATM_TRANSMITTANCE, Math.pow(am, CONSTANTS.CLEARSKY_AM_EXPONENT));
    const tcell = temp[i] + (CONSTANTS.PV_NOCT_C - CONSTANTS.PV_NOCT_AMBIENT_C) *
      (ghi / CONSTANTS.PV_NOCT_IRRADIANCE_W_M2);
    const derate = 1 + CONSTANTS.PV_TEMP_COEFF_PCT_PER_C / 100 * (tcell - CONSTANTS.PV_REF_TEMP_C);
    raw[i] = Math.max(0, ghi * derate);
  }
  // Re-weight to the library's monthly distribution
  const shareSum = loc.monthlyYieldShare.reduce((a, b) => a + b, 0);
  const monthRaw = new Float64Array(12);
  for (let i = 0; i < H; i++) monthRaw[cal.month[i]] += raw[i];
  let rawTotal = 0;
  for (let m = 0; m < 12; m++) rawTotal += monthRaw[m];
  const kMonth = new Float64Array(12);
  for (let m = 0; m < 12; m++) {
    kMonth[m] = monthRaw[m] > 0 ? (loc.monthlyYieldShare[m] / shareSum) / (monthRaw[m] / rawTotal) : 0;
  }
  let total = 0;
  for (let i = 0; i < H; i++) { raw[i] *= kMonth[cal.month[i]]; total += raw[i]; }
  // Anchor magnitude to the stated specific yield
  const k = total > 0 ? loc.specificYield_kWh_per_kWp / total : 0;
  for (let i = 0; i < H; i++) raw[i] *= k;
  return raw;
}

/**
 * Parametric 8760 load synthesis, kW.
 *   load[h] = base + (peak − base) · shape01[h]^γ
 * shape01 is the normalised weekday/weekend/seasonal shape (max = 1, min = 0),
 * so peak and base are matched exactly by construction. γ is then solved by
 * bisection so that the annual energy matches the target. γ is reported.
 */
function synthesiseLoad(p) {
  const cal = p.cal;
  const shape = LOAD_SHAPES[p.shapeKey] || LOAD_SHAPES.continuous;
  const wd = p.shapeKey === "custom" ? p.customWeekday : shape.weekday;
  const we = p.shapeKey === "custom" ? p.customWeekend : shape.weekend;
  const raw = new Float32Array(H);
  const peakDay = p.seasonalPeak === "winter" ? 15 : p.seasonalPeak === "summer" ? 197 : -1;
  for (let i = 0; i < H; i++) {
    const isWeekend = cal.dow[i] === 0 || cal.dow[i] === 6;
    let v = (isWeekend ? we[cal.hourOfDay[i]] * p.weekendFactor : wd[cal.hourOfDay[i]]);
    if (peakDay >= 0) v *= 1 + (p.seasonality / 100) * Math.cos(2 * Math.PI * (cal.doy[i] - peakDay) / 365);
    raw[i] = Math.max(0, v);
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < H; i++) { if (raw[i] < mn) mn = raw[i]; if (raw[i] > mx) mx = raw[i]; }
  const span = mx - mn || 1;
  const s01 = new Float32Array(H);
  for (let i = 0; i < H; i++) s01[i] = (raw[i] - mn) / span;

  const targetMWh = p.annualEnergyMWh;
  const energyAt = (g) => { let e = 0; for (let i = 0; i < H; i++) e += p.baseKW + (p.peakKW - p.baseKW) * Math.pow(s01[i], g); return e / 1000; };
  const eMin = energyAt(CONSTANTS.SHAPE_GAMMA_MAX);
  const eMax = energyAt(CONSTANTS.SHAPE_GAMMA_MIN);
  let gamma = 1, clamped = null;
  if (targetMWh <= eMin) { gamma = CONSTANTS.SHAPE_GAMMA_MAX; clamped = "low"; }
  else if (targetMWh >= eMax) { gamma = CONSTANTS.SHAPE_GAMMA_MIN; clamped = "high"; }
  else {
    let lo = CONSTANTS.SHAPE_GAMMA_MIN, hi = CONSTANTS.SHAPE_GAMMA_MAX;
    for (let it = 0; it < 60; it++) {
      gamma = (lo + hi) / 2;
      const e = energyAt(gamma);
      if (Math.abs(e - targetMWh) < CONSTANTS.SHAPE_GAMMA_TOL_MWH) break;
      if (e > targetMWh) lo = gamma; else hi = gamma;
    }
  }
  const load = new Float32Array(H);
  for (let i = 0; i < H; i++) load[i] = p.baseKW + (p.peakKW - p.baseKW) * Math.pow(s01[i], gamma);
  return { load, gamma, clamped, feasibleMWh: [eMin, eMax] };
}

/**
 * AIDC facility load derivation for one ramp year.
 * Total = IT + cooling(T_ambient) + other, all kW.
 * Cooling power is a linear function of dry-bulb between the free-cooling
 * threshold and the design ambient, floored at the fan/pump fraction and
 * capped at the overload fraction.
 */
function deriveAIDCLoad(a, temp, mwIT) {
  const cool = CONSTANTS.COOLING[a.coolingType] || CONSTANTS.COOLING.air;
  const itKW = mwIT * 1000 * (a.itUtilisationPct / 100);
  const otherPct = (a.upsPresent ? CONSTANTS.UPS_LOSS_PCT_OF_IT : 0)
    + CONSTANTS.DISTRIBUTION_LOSS_PCT_OF_IT + CONSTANTS.MISC_LOAD_PCT_OF_IT;
  const otherKW = itKW * otherPct / 100;
  const coolingDesignKW = Math.max(0, itKW * (a.designPUE - 1) - otherKW);
  const tFree = a.freeCoolingBelowC, tDes = a.designAmbientC;
  const total = new Float32Array(H), coolArr = new Float32Array(H);
  let freeHours = 0, aboveDesignHours = 0;
  for (let i = 0; i < H; i++) {
    let f;
    if (temp[i] <= tFree) { f = cool.minCoolingFrac; freeHours++; }
    else {
      f = cool.minCoolingFrac + (1 - cool.minCoolingFrac) * (temp[i] - tFree) / Math.max(0.1, tDes - tFree);
      if (f > cool.overloadCap) f = cool.overloadCap;
      if (temp[i] > tDes) aboveDesignHours++;
    }
    coolArr[i] = coolingDesignKW * f;
    total[i] = itKW + coolArr[i] + otherKW;
  }
  let e = 0; for (let i = 0; i < H; i++) e += total[i];
  const annualisedPUE = itKW > 0 ? (e / H) / itKW : 0;
  // Load at the design condition (cooling at 100 % of design), which is the
  // basis for firm capacity. A typical meteorological year never reaches the
  // design ambient at a cool site, so the simulated peak must NOT be used to
  // size firm plant — it would undersize the design.
  const designConditionKW = itKW + coolingDesignKW + otherKW;
  return {
    load: total, cooling: coolArr, itKW, otherKW, coolingDesignKW, designConditionKW,
    annualisedPUE, freeHours, aboveDesignHours, otherPct,
  };
}

/* --- CSV load parsing ------------------------------------------------------ */

function parseLoadCSV(text) {
  const res = Papa.parse(text.trim(), { header: false, skipEmptyLines: true, dynamicTyping: false });
  let rows = res.data;
  const notes = [];
  if (!rows.length) return { error: "The file contains no rows." };

  // Header detection
  let headerRow = null;
  const first = rows[0].map((c) => String(c).trim());
  if (first.some((c) => isNaN(parseFloat(c)) && c.length)) { headerRow = first; rows = rows.slice(1); }

  // Column selection
  let tsCol = -1, valCol = -1;
  if (headerRow) {
    headerRow.forEach((h, i) => {
      const s = h.toLowerCase();
      if (tsCol < 0 && /time|date|stamp|hour|period/.test(s)) tsCol = i;
      if (valCol < 0 && /kw|kwh|mw|load|power|demand|value|consum/.test(s)) valCol = i;
    });
  }
  if (valCol < 0) valCol = rows[0].length > 1 ? 1 : 0;
  if (tsCol < 0 && rows[0].length > 1) tsCol = 0;
  notes.push(`Value column: ${headerRow ? headerRow[valCol] : `column ${valCol + 1}`}.`);

  // Extract
  const raw = [];
  let nonNumeric = 0;
  for (const r of rows) {
    const v = parseFloat(String(r[valCol]).replace(",", "."));
    if (isNaN(v)) { nonNumeric++; raw.push(null); } else raw.push(v);
  }
  if (nonNumeric) notes.push(`${nonNumeric} non-numeric value${nonNumeric > 1 ? "s" : ""} treated as gaps.`);

  // Hourly analysis only. Sub-hourly data is rejected with instructions rather
  // than silently averaged — an averaged 15-minute series hides exactly the
  // peaks the power and dynamic checks depend on.
  const n = raw.length;
  if (n > 9000) {
    return { error: `The file has ${n} rows, which is not an hourly series. This tool runs an hourly analysis only — aggregate to 8760 hourly values before uploading (${n === 35040 ? "15-minute" : n === 17520 ? "30-minute" : "sub-hourly"} data detected). Download the template for the expected format.` };
  }
  notes.push(`${n} rows read as an hourly series.`);

  // Duplicate timestamps
  let dupes = 0;
  if (tsCol >= 0) {
    const seen = new Set(); const keep = [];
    for (let i = 0; i < rows.length; i++) {
      const k = String(rows[i][tsCol]).trim();
      if (k && seen.has(k)) { dupes++; continue; }
      if (k) seen.add(k);
      keep.push(raw[i]);
    }
    if (dupes) { raw.length = keep.length; for (let i = 0; i < keep.length; i++) raw[i] = keep[i]; notes.push(`${dupes} duplicated timestamp${dupes > 1 ? "s" : ""} dropped (first occurrence kept).`); }
  }

  const hourly = raw.slice();

  // Leap year
  if (hourly.length === 8784) { hourly.splice(59 * 24, 24); notes.push("Leap year detected — 29 February removed."); }

  // Negatives
  let negs = 0;
  for (let i = 0; i < hourly.length; i++) if (hourly[i] !== null && hourly[i] < 0) { negs++; hourly[i] = 0; }
  if (negs) notes.push(`${negs} negative value${negs > 1 ? "s" : ""} clamped to 0 kW.`);

  // Gap filling — same hour of the adjacent day, else linear, else annual mean
  let gaps = 0;
  const valid = hourly.filter((v) => v !== null);
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  for (let i = 0; i < hourly.length; i++) {
    if (hourly[i] === null) {
      gaps++;
      const prevDay = i - 24 >= 0 ? hourly[i - 24] : null;
      const nextDay = i + 24 < hourly.length ? hourly[i + 24] : null;
      if (prevDay !== null && prevDay !== undefined) hourly[i] = prevDay;
      else if (nextDay !== null && nextDay !== undefined) hourly[i] = nextDay;
      else hourly[i] = mean;
    }
  }
  if (gaps) notes.push(`${gaps} gap${gaps > 1 ? "s" : ""} filled from the same hour of the adjacent day.`);

  // Length
  let lengthNote = null;
  if (hourly.length > H) { lengthNote = `Series truncated from ${hourly.length} h to 8760 h.`; hourly.length = H; }
  else if (hourly.length < H) {
    lengthNote = `Series padded from ${hourly.length} h to 8760 h by repeating the last full week.`;
    const src = hourly.slice(-168).length ? hourly.slice(-168) : [mean];
    let k = 0; while (hourly.length < H) { hourly.push(src[k % src.length]); k++; }
  }
  if (lengthNote) notes.push(lengthNote);

  const arr = Float32Array.from(hourly);
  return { load: arr, notes, rowsIn: n, detected: "hourly" };
}

/* --- Statistics ------------------------------------------------------------ */

function loadStats(load, cal) {
  let e = 0, peak = -Infinity, min = Infinity, peakH = 0;
  for (let i = 0; i < H; i++) { e += load[i]; if (load[i] > peak) { peak = load[i]; peakH = i; } if (load[i] < min) min = load[i]; }
  const monthly = new Float64Array(12);
  for (let i = 0; i < H; i++) monthly[cal.month[i]] += load[i] / 1000;
  return {
    annualMWh: e / 1000, peakKW: peak, minKW: min, meanKW: e / H,
    loadFactor: peak > 0 ? (e / H) / peak : 0, peakHour: peakH, monthlyMWh: Array.from(monthly),
  };
}

function durationCurve(load, points = 200) {
  const sorted = Array.from(load).sort((a, b) => b - a);
  const out = [];
  for (let i = 0; i < points; i++) {
    const idx = Math.floor(i / (points - 1) * (H - 1));
    out.push({ pct: +(idx / (H - 1) * 100).toFixed(1), kW: +sorted[idx].toFixed(1) });
  }
  return out;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmt = (v, d = 1) => (v === null || v === undefined || isNaN(v) ? "—" : Number(v).toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }));
function dayLabel(dayIndex) {
  let d = dayIndex, m = 0;
  while (d >= CONSTANTS.DAYS_PER_MONTH[m]) { d -= CONSTANTS.DAYS_PER_MONTH[m]; m++; }
  return `${d + 1} ${MONTHS[m]}`;
}

/* ============================================================================
   PHASE 2 ENGINE — generation profiles and the dispatch
   ========================================================================== */

/* --- Deterministic pseudo-random sequence (so a site always gives the same year) */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
}
/** Abramowitz & Stegun 26.2.17 normal CDF. */
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
/** Lanczos gamma, needed for the Weibull scale parameter. */
function gammaFn(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/**
 * Hourly wind speed at hub height (m/s).
 * Weibull marginal distribution with an AR(1) memory, plus a seasonal factor.
 * Deterministic: the same site and hub height always return the same year.
 */
function buildWindSpeed(loc, cal, hubHeightM) {
  const shear = Math.pow(hubHeightM / CONSTANTS.WIND_REFERENCE_HEIGHT_M, CONSTANTS.WIND_SHEAR_EXPONENT);
  const meanHub = loc.windMean_m_s_100m * shear;
  const k = loc.weibullK;
  const c = meanHub / gammaFn(1 + 1 / k);          // Weibull scale, m/s
  const rnd = lcg(CONSTANTS.WIND_RANDOM_SEED + Math.round(loc.lat * 100));
  const rho = CONSTANTS.WIND_AR1_RHO, sd = Math.sqrt(1 - rho * rho);
  const v = new Float32Array(H);
  let x = 0;
  for (let i = 0; i < H; i++) {
    // Box–Muller
    const u1 = Math.max(1e-9, rnd()), u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    x = rho * x + sd * z;
    const u = Math.min(0.9999, Math.max(0.0001, normCdf(x)));
    const season = 1 + CONSTANTS.WIND_SEASONAL_AMPLITUDE *
      Math.cos(2 * Math.PI * (cal.doy[i] - CONSTANTS.WIND_SEASON_PEAK_DOY) / 365);
    v[i] = c * Math.pow(-Math.log(1 - u), 1 / k) * season;
  }
  return v;
}

/**
 * Wind farm output (kW) from the hourly speed.
 * Cubic between cut-in and rated, flat to cut-out, zero outside.
 * Air density is corrected for ambient temperature — a hot site produces less.
 */
function buildWindGen(speed, temp, w) {
  const out = new Float32Array(H);
  const vin = w.cutInMs, vr = w.ratedMs, vout = w.cutOutMs;
  const lossFactor = (w.availabilityPct / 100) * (1 - CONSTANTS.WIND_WAKE_AND_ARRAY_LOSS_PCT / 100);
  for (let i = 0; i < H; i++) {
    const v = speed[i];
    let f = 0;
    if (v >= vin && v < vr) f = (v * v * v - vin * vin * vin) / (vr * vr * vr - vin * vin * vin);
    else if (v >= vr && v <= vout) f = 1;
    const rho = CONSTANTS.AIR_PRESSURE_PA / (CONSTANTS.AIR_GAS_CONSTANT_J_KG_K * (temp[i] + 273.15));
    const densityFactor = v < vr ? rho / CONSTANTS.AIR_DENSITY_REF_KG_M3 : 1; // above rated the turbine pitches back
    out[i] = w.ratedKW * f * densityFactor * lossFactor;
  }
  return out;
}

/** PV plant output (kW) — specific yield profile × kWp, with losses, degradation and inverter clipping. */
function buildPVGen(pvUnit, pv, year) {
  const out = new Float32Array(H);
  const acLimitKW = pv.kWp / pv.dcacRatio;
  const derate = (1 - pv.soilingPct / 100) * (1 + pv.bifacialGainPct / 100)
    * (pv.availabilityPct / 100) * (1 - pv.otherLossesPct / 100)
    * (1 - pv.degradationPctPerYr / 100 * (year - 1));
  let clippedH = 0;
  for (let i = 0; i < H; i++) {
    const dc = pvUnit[i] * pv.kWp * derate;
    if (dc > acLimitKW) { out[i] = acLimitKW; clippedH++; } else out[i] = dc;
  }
  return { gen: out, clippedHours: clippedH, acLimitKW };
}

/**
 * Hourly import price, €/MWh delivered.
 *   flat    — one price all year
 *   tou     — peak / off-peak multipliers on the site tariff
 *   market  — the 2025 wholesale shape for this country, scaled to its published
 *             annual average, plus the site's grid fees
 *   uploaded— an 8760 series supplied by the user, plus grid fees
 */
function buildTariff(loc, cal, tariff, uploadedPrice, solarProfile, windProfile) {
  const p = new Float32Array(H);
  const base = loc.importTariff_EUR_per_MWh + loc.gridFee_EUR_per_MWh;

  if (tariff.structure === "uploaded" && uploadedPrice) {
    for (let i = 0; i < H; i++) p[i] = uploadedPrice[i] + loc.gridFee_EUR_per_MWh;
    return p;
  }

  if (tariff.structure === "market") {
    const mkt = MARKET_PRICES_2025[loc.country] || MARKET_PRICES_2025.OTHER;
    const target = mkt.annualAvg_EUR_per_MWh || loc.importTariff_EUR_per_MWh;
    const vre = VRE_PENETRATION_2025[loc.country] || VRE_PENETRATION_2025.OTHER;

    // Normalise the site's own solar and wind series to a mean of one, so they can
    // stand in for national output. Same arrays the PV plant and wind farm use.
    const norm = (arr) => {
      if (!arr) return null;
      let m = 0; for (let i = 0; i < H; i++) m += arr[i];
      m /= H; if (m <= 0) return null;
      const out = new Float32Array(H);
      for (let i = 0; i < H; i++) out[i] = arr[i] / m;
      return out;
    };
    const solarN = norm(solarProfile);
    const windN = norm(windProfile);

    // Residual demand = national demand shape − solar − wind
    const resid = new Float32Array(H);
    let residSum = 0;
    for (let i = 0; i < H; i++) {
      const weekend = cal.dow[i] === 0 || cal.dow[i] === 6;
      const dem = DEMAND_MONTHLY_INDEX[cal.month[i]]
        * (weekend ? DEMAND_HOURLY_INDEX.weekend : DEMAND_HOURLY_INDEX.weekday)[cal.hourOfDay[i]];
      const solar = solarN ? vre.solar * solarN[i] : 0;
      const wind = windN ? vre.wind * windN[i] : vre.wind;
      resid[i] = dem - solar - wind;
      residSum += resid[i];
    }
    const residMean = residSum / H;

    // The hours that clear below zero are the lowest-residual hours of the year.
    // The threshold is the percentile matching the observed share, not a fixed level.
    const sortedR = Array.from(resid).sort((x, y) => x - y);
    // Residual itself can be negative in a high-renewable market, so the threshold
    // is kept on the raw ratio rather than the clamped one.
    const negThreshold = sortedR[Math.floor(H * CONSTANTS.PRICE_NEGATIVE_HOUR_SHARE)] / (residMean || 1);
    const negSpan = Math.max(0.10, Math.abs(negThreshold) + 0.10);

    // Convex supply curve: price rises steeply as residual demand approaches the
    // top of the merit order, and collapses when wind and solar cover the load.
    const idx = new Float32Array(H);
    let rawSum = 0;
    for (let i = 0; i < H; i++) {
      const r = residMean > 0 ? Math.max(0, resid[i] / residMean) : 1;
      idx[i] = Math.min(CONSTANTS.PRICE_CAP_MULTIPLE, Math.pow(r, CONSTANTS.PRICE_RESIDUAL_ELASTICITY));
      rawSum += idx[i];
    }
    // Damp both tails for interconnection, hydro and flexible plant, then apply the
    // negative-price adjustment so the share of sub-zero hours is preserved.
    const rawMean = rawSum / H;
    let idxSum = 0;
    for (let i = 0; i < H; i++) {
      let v = rawMean + (idx[i] - rawMean) * (1 - CONSTANTS.PRICE_DAMPING);
      const rRaw = residMean > 0 ? resid[i] / residMean : 1;
      if (rRaw < negThreshold) {
        v -= CONSTANTS.PRICE_NEGATIVE_DEPTH * Math.min(2, (negThreshold - rRaw) / negSpan);
      }
      idx[i] = v; idxSum += v;
    }
    const k = idxSum > 0 ? target / (idxSum / H) : 0;   // scale to the published annual average
    for (let i = 0; i < H; i++) p[i] = idx[i] * k + loc.gridFee_EUR_per_MWh;
    return p;
  }

  for (let i = 0; i < H; i++) {
    if (tariff.structure === "flat") p[i] = base;
    else {
      const weekday = cal.dow[i] !== 0 && cal.dow[i] !== 6;
      const peak = weekday && cal.hourOfDay[i] >= tariff.peakStartHour && cal.hourOfDay[i] < tariff.peakEndHour;
      p[i] = base * (peak ? tariff.peakMultiplier : tariff.offPeakMultiplier);
    }
  }
  return p;
}

/** Interpolate a part-load curve given at 25/50/75/100 % of rating. */
function partLoadValue(curve, loadPct) {
  const pts = CONSTANTS.ENGINE_LOAD_POINTS_PCT;
  if (loadPct <= pts[0]) return curve[0];
  if (loadPct >= pts[pts.length - 1]) return curve[curve.length - 1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (loadPct >= pts[i] && loadPct <= pts[i + 1]) {
      const f = (loadPct - pts[i]) / (pts[i + 1] - pts[i]);
      return curve[i] + f * (curve[i + 1] - curve[i]);
    }
  }
  return curve[curve.length - 1];
}

export const REASON_CODES = [
  "RENEWABLE",       //  0  load fully covered by renewables
  "GRID",            //  1  grid import, nothing binding
  "IMPORT_CAP",      //  2  import limited by the connection cap
  "CURTAIL_SCHED",   //  3  non-firm connection curtailed this hour
  "BESS_DISCHARGE",  //  4  battery discharging, nothing binding
  "SOC_RESERVE",     //  5  battery held at the resilience reserve — energy exists but is ring-fenced
  "BESS_EMPTY",      //  5b battery at its floor, no energy left — a different problem from the reserve
  "PEAK_SHAVE",      //  5c battery discharging to hold import below the demand-charge target
  "HOLD_FOR_PEAK",   //  5d battery holding energy back for a larger peak later in the horizon
  "CHEAP_HOURS",     //  5e charging because this is among the cheapest hours in the horizon
  "BESS_CHEAPER",    //  5f discharging ahead of the grid because stored energy costs less right now
  "BESS_POWER",      //  6  battery limited by rated power or C-rate
  "ENGINE_ON",       //  7  engines running, loaded normally
  "ENGINE_MIN_LOAD", //  8  engine held at minimum stable load, surplus dumped
  "ENGINE_START",    //  9  engine committed but still starting
  "ENGINE_HOURS",    // 10  annual running-hour budget exhausted
  "MIN_UP_DOWN",     // 11  minimum up or down time blocked the change
  "TURBINE_ON",      // 12  gas turbine carrying the residual
  "CHARGE",          // 13  charging the battery
  "EXPORT",          // 14  exporting surplus
  "CURTAIL",         // 15  renewable surplus curtailed
  "SHED_T2",         // 16  tier 2 load shed
  "SHED_T1",         // 17  tier 1 load shed
  "UNSERVED",        // 18  critical load not served
];
const RC = Object.fromEntries(REASON_CODES.map((c, i) => [c, i]));

/* Plain-language labels for the audit table and the filter. The short codes stay
   in the data and the Excel export; the UI shows the sentence. */
export const REASON_INFO = {
  RENEWABLE:       { group: "Normal",      label: "Renewables covered the load",            hint: "PV and wind alone met demand this hour" },
  GRID:            { group: "Normal",      label: "Grid supplied the balance",              hint: "import within the cap covered what renewables did not" },
  BESS_DISCHARGE:  { group: "Normal",      label: "Battery discharged",                     hint: "battery covered the balance, nothing binding" },
  CHARGE:          { group: "Normal",      label: "Battery charged",                        hint: "surplus renewables, or cheap grid hours, went into storage" },
  EXPORT:          { group: "Normal",      label: "Surplus exported",                       hint: "excess renewable energy sold to the grid" },
  ENGINE_ON:       { group: "Normal",      label: "Engines carried the balance",            hint: "engines loaded normally, above minimum stable load" },
  TURBINE_ON:      { group: "Normal",      label: "Turbine carried the balance",            hint: "gas turbine loaded normally" },
  PEAK_SHAVE:      { group: "Normal",      label: "Battery shaved the peak",                hint: "import held below the demand-charge target" },
  HOLD_FOR_PEAK:   { group: "Normal",      label: "Battery held back for a bigger peak",    hint: "a larger peak is coming within the horizon, so energy was kept for it" },
  BESS_CHEAPER:    { group: "Normal",      label: "Battery used instead of the grid",       hint: "the stored energy cost less than importing at this hour's price" },
  CHEAP_HOURS:     { group: "Normal",      label: "Charged in a cheap hour",                hint: "among the cheapest hours in the horizon, and the surplus ahead will not fill the battery" },
  CURTAIL:         { group: "Waste",       label: "Renewables curtailed",                   hint: "generation that could not be used, stored or exported" },
  IMPORT_CAP:      { group: "Constrained", label: "Import cap reached",                     hint: "the connection was full — this is why other assets ran" },
  CURTAIL_SCHED:   { group: "Constrained", label: "Non-firm curtailment in force",          hint: "the network reduced the allowed import this hour" },
  BESS_POWER:      { group: "Constrained", label: "Battery at its power limit",             hint: "energy was available but the inverter or C-rate capped output" },
  BESS_EMPTY:      { group: "Constrained", label: "Battery empty",                          hint: "state of charge at the floor — no energy left to give" },
  SOC_RESERVE:     { group: "Constrained", label: "Battery held at resilience reserve",     hint: "energy exists but is ring-fenced for islanding" },
  MIN_UP_DOWN:     { group: "Constrained", label: "Engine blocked by min up/down time",     hint: "the unit could not start or stop yet" },
  ENGINE_START:    { group: "Constrained", label: "Engine still starting",                  hint: "committed but not yet on load" },
  ENGINE_HOURS:    { group: "Waste",       label: "Engine hour budget exhausted",           hint: "the permitted annual running hours are used up" },
  ENGINE_MIN_LOAD: { group: "Waste",       label: "Engine at minimum load, surplus dumped", hint: "the unit cannot turn down further, so energy is wasted" },
  SHED_T2:         { group: "Failure",     label: "Tier 2 load shed",                       hint: "lowest-priority load disconnected" },
  SHED_T1:         { group: "Failure",     label: "Tier 1 load shed",                       hint: "second-priority load disconnected" },
  UNSERVED:        { group: "Failure",     label: "Load not served",                        hint: "critical load could not be met" },
};
export const REASON_GROUPS = ["Normal", "Constrained", "Waste", "Failure"];

/* Severity ranking. The hour's reason code is the HIGHEST-severity constraint
   that bound that hour, so a battery discharging because the import cap is
   full still reports IMPORT_CAP — the cap is why the battery ran. */
const SEVERITY = {
  // Normal operation
  RENEWABLE: 0, GRID: 1, EXPORT: 2, CHARGE: 2, BESS_DISCHARGE: 2,
  ENGINE_ON: 3, TURBINE_ON: 3, PEAK_SHAVE: 3, HOLD_FOR_PEAK: 3, CHEAP_HOURS: 2, BESS_CHEAPER: 2, CURTAIL: 4,
  // Asset state — an asset ran out of room or energy
  BESS_POWER: 5, BESS_EMPTY: 5, SOC_RESERVE: 5, MIN_UP_DOWN: 6, ENGINE_START: 6,
  // Structural limits — these are WHY the other assets had to run, so they outrank
  // asset state. A battery sitting at its floor behind a full import cap is a
  // consequence of the cap, and the cap is the finding worth reporting.
  IMPORT_CAP: 7, CURTAIL_SCHED: 7,
  // Waste and permit limits
  ENGINE_HOURS: 8, ENGINE_MIN_LOAD: 8,
  // Failure to serve
  SHED_T2: 9, SHED_T1: 10, UNSERVED: 11,
};
const SEV = REASON_CODES.map((c) => SEVERITY[c]);

/**
 * DISPATCH — hourly, deterministic, priority merit order. Not an optimiser.
 *
 * Every hour, in this fixed order:
 *   1  serve load from renewables
 *   2  import from the grid up to the cap, subject to the curtailment schedule
 *   3  discharge the battery, never below the reserve SOC when islanding is required
 *   4  commit engines, then the turbine, respecting minimum stable load,
 *      minimum up/down time, start time and the annual running-hour budget
 *   5  charge the battery from surplus renewables, then from cheap grid hours
 *   6  curtail or export what is left
 *   7  record unserved energy and shed load by tier
 *
 * One reason code per hour records the constraint that actually bound the
 * outcome, chosen by severity. Every array below is retained for the audit table.
 */
/* Short-run marginal cost of one MWh from the engine fleet, €/MWh electrical:
   fuel at the stated evaluation load point plus variable O&M at the same load
   point. Written once and used by the dispatch, by the search-space proposal
   and by the screen that reports it, so the three can never disagree. */
function engineMarginalCostEURperMWh(e, dieselPrice, gasPrice) {
  const lp = CONSTANTS.ENGINE_ECONOMIC_LOAD_POINT_PCT;
  const sfc = (e && e.sfcDiesel) || CONSTANTS.DIESEL_SFC_L_PER_KWH;
  const eff = (e && e.effGas) || CONSTANTS.GAS_ENGINE_EFF_PCT;
  const fuel = (e && e.fuelType === "diesel")
    ? 1000 * partLoadValue(sfc, lp) * (dieselPrice || 0)
    : (gasPrice || 0) / Math.max(0.01, partLoadValue(eff, lp) / 100);
  const om = ((e && e.omEURperRunHourPerMW) || 0) / (lp / 100);
  const v = fuel + om;
  return isFinite(v) ? v : 0;
}

function dispatch(cfg) {
  const { load, pvGen, windGen, price, temp, cal, hoursOfYear = H } = cfg;
  const g = cfg.grid, b = cfg.bess, e = cfg.engine, t = cfg.turbine;

  const out = {
    pv: new Float32Array(H), wind: new Float32Array(H), imp: new Float32Array(H),
    exp: new Float32Array(H), bess: new Float32Array(H), soc: new Float32Array(H),
    engine: new Float32Array(H), turbine: new Float32Array(H), curtail: new Float32Array(H),
    unserved: new Float32Array(H), shed1: new Float32Array(H), shed2: new Float32Array(H),
    enginesOn: new Uint8Array(H), reason: new Uint8Array(H), fuelL: new Float32Array(H),
    aux: new Float32Array(H),
    fuelTh: new Float32Array(H),
  };

  // Battery state
  const usableKWh = b.enabled ? b.energyKWh * (b.socMaxPct - b.socMinPct) / 100 : 0;
  const reserveFloorPct = b.reserveApplies ? Math.max(b.socMinPct, b.reserveSocPct) : b.socMinPct;
  let soc = b.enabled ? b.startSocPct : 0;                       // % of nameplate
  const powerLimitKW = b.enabled ? Math.min(b.powerKW, b.energyKWh * b.cRate) : 0;
  const effOneWay = Math.sqrt(b.rteFraction);
  let throughputKWh = 0;

  // Engine fleet state
  let unitsOn = 0, lastChangeH = -999, engineRunHours = 0, startingUntil = -1;
  const unitMinKW = e.unitKW * e.minStableLoadPct / 100;
  // Turbine state
  let turbOn = false, turbLastChangeH = -999, turbRunHours = 0;

  const meanPrice = price.reduce((a, v) => a + v, 0) / H;
  const thermalFirst = cfg.meritOrder === "thermal-first";
  const forced = cfg.forcedBattery || null;

  /* --- Short-run marginal cost of the engine fleet, €/MWh electrical -------
     Fuel at the stated evaluation load point plus variable O&M at the same
     load point. Both prices are taken from the dispatch input; nothing here
     reads a price the caller has not supplied. The figure is only used when
     economic running is switched on, and it is reported on the output so the
     comparison the dispatch made can be checked against the tariff. */
  const engineMarginalEURperMWh = engineMarginalCostEURperMWh(e, cfg.dieselPrice, cfg.gasPrice);
  const engineStartPrice = engineMarginalEURperMWh * CONSTANTS.ENGINE_ECONOMIC_START_MARGIN;
  const engineEconomic = !!e.economicRun && e.enabled && e.units > 0;
  let engineEconomicHours = 0;

  /* --- Look-ahead ---------------------------------------------------------
     A finite horizon over the same hourly series. This is a perfect forecast,
     not a real one: a live plant would use an imperfect forecast and do
     slightly worse. Two rules, both deterministic and both auditable.        */
  const LA = cfg.lookahead && cfg.lookahead.enabled;
  const W = LA ? Math.max(1, cfg.lookahead.horizonH) : 0;
  let surplusAhead = null, cheapHour = null;
  if (LA) {
    // Renewable surplus expected over the horizon — do not fill the battery
    // from the grid with energy the sun is about to give away.
    const surplusEach = new Float32Array(H);
    for (let i = 0; i < H; i++) surplusEach[i] = Math.max(0, (pvGen ? pvGen[i] : 0) + (windGen ? windGen[i] : 0) - load[i]);
    const prefix = new Float64Array(H + 1);
    for (let i = 0; i < H; i++) prefix[i + 1] = prefix[i] + surplusEach[i];
    surplusAhead = new Float32Array(H);
    for (let i = 0; i < H; i++) surplusAhead[i] = prefix[Math.min(H, i + W)] - prefix[i];

    // Is this hour among the cheapest in its own horizon?
    cheapHour = new Uint8Array(H);
    const k = Math.max(1, Math.round(W * CONSTANTS.LOOKAHEAD_CHEAP_FRACTION));
    for (let i = 0; i < H; i++) {
      let cheaper = 0;
      const end = Math.min(H, i + W);
      for (let j = i; j < end; j++) if (price[j] < price[i]) cheaper++;
      cheapHour[i] = cheaper < k ? 1 : 0;
    }
  }

  /* Peak levelling. Given the residual demand over the horizon and the energy
     the battery can supply, find the level L such that the energy above L
     equals that energy. Discharging only down to L flattens the horizon's
     peaks instead of collapsing into the first one. */
  const levelForHorizon = (start, availKWh, capKW) => {
    const end = Math.min(H, start + W);
    let hi = 0;
    const resid = [];
    for (let j = start; j < end; j++) {
      const r = load[j] - (pvGen ? pvGen[j] : 0) - (windGen ? windGen[j] : 0) - capKW;
      resid.push(r);
      if (r > hi) hi = r;
    }
    if (hi <= 0) return hi;
    let lo = 0;
    for (let it = 0; it < CONSTANTS.LOOKAHEAD_BISECTION_STEPS; it++) {
      const mid = (lo + hi) / 2;
      let e = 0;
      for (let k2 = 0; k2 < resid.length; k2++) if (resid[k2] > mid) e += resid[k2] - mid;
      if (e > availKWh) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  let curtailRenewTotal = 0, renewServedTotal = 0;
  // Weighted average cost of the energy currently in the battery, €/MWh.
  // Surplus renewables enter at zero; grid energy enters at the hour's price.
  let storedCostEURperMWh = 0;
  const wearEURperMWh = b.wearCostEURperMWh !== undefined ? b.wearCostEURperMWh : CONSTANTS.BESS_WEAR_COST_EUR_PER_MWH;

  for (let i = 0; i < hoursOfYear; i++) {
    let reason = RC.RENEWABLE;
    const mark = (code) => { if (SEV[code] >= SEV[reason]) reason = code; };
    const loadKW = load[i];

    /* --- 1. Renewables ---------------------------------------------------- */
    const pvAvail = pvGen ? pvGen[i] : 0;
    const windAvail = windGen ? windGen[i] : 0;
    const renewAvail = pvAvail + windAvail;
    let residual = loadKW;
    const renewToLoad = Math.min(renewAvail, residual);
    residual -= renewToLoad;
    renewServedTotal += renewToLoad;
    let surplus = renewAvail - renewToLoad;
    out.pv[i] = pvAvail; out.wind[i] = windAvail;

    // Battery auxiliary load is part of the site load, not free
    const auxKW = b.enabled ? b.powerKW * CONSTANTS.BESS_AUX_PCT_OF_RATING / 100 : 0;
    out.aux[i] = auxKW;
    if (auxKW > 0) { const fromSurplus = Math.min(surplus, auxKW); surplus -= fromSurplus; residual += auxKW - fromSurplus; }

    /* --- 2. Grid import --------------------------------------------------- */
    let capKW = 0, curtailedHour = false;
    if (g.enabled) {
      capKW = g.importCapKW;
      if (g.nonFirm && g.curtailFlags[i]) { capKW = g.reducedCapKW; curtailedHour = true; }
    }
    // Peak shaving holds import below a demand-charge target. The full cap stays
    // available as a backstop in step 3b, after the battery has done what it can.
    const shaveCap = (g.enabled && g.shaveEnabled && g.shaveTargetKW > 0) ? Math.min(capKW, g.shaveTargetKW) : capKW;

    const runGridImport = () => {
      const imp = Math.min(residual, shaveCap);
      if (imp > 0) { out.imp[i] = imp; residual -= imp; mark(RC.GRID); }
      if (g.enabled && residual > 0.001 && shaveCap < capKW) mark(RC.PEAK_SHAVE);
      else if (g.enabled && residual > 0.001 && capKW > 0) mark(curtailedHour ? RC.CURTAIL_SCHED : RC.IMPORT_CAP);
      else if (g.enabled && residual > 0.001 && capKW === 0 && curtailedHour) mark(RC.CURTAIL_SCHED);
    };

    /* --- 3 & 4. The discretionary middle of the merit order -----------------
       Renewables always come first and load shedding always comes last — those
       are physics and priority, not preference. What IS a choice is whether the
       battery or the thermal plant covers the gap after grid import, and the
       use case decides it: a cost-driven site discharges the battery first to
       avoid fuel, while a resilience-driven site starts engines first and keeps
       the battery in reserve. Both orders are run by the same code below.     */
    let disKW = 0;
    let engineExcess = 0;
    let batteryDone = false;

    const runBattery = () => {
      // When an optimiser has already chosen this hour's battery power, follow
      // it exactly rather than re-deciding; everything else stays rule-based.
      if (forced) {
        const want = forced[i];
        if (want > 0.001) {
          const availKWh = Math.max(0, (soc - reserveFloorPct) / 100 * b.energyKWh) * effOneWay;
          const dis = Math.min(want, residual, powerLimitKW, availKWh);
          if (dis > 0.001) {
            disKW = dis; residual -= dis;
            soc -= (dis / effOneWay) / b.energyKWh * 100;
            throughputKWh += dis;
            mark(RC.BESS_DISCHARGE);
          }
        }
        batteryDone = true; return;
      }
      if (!b.enabled || residual <= 0.001) { batteryDone = true; return; }
      const availKWh = Math.max(0, (soc - reserveFloorPct) / 100 * b.energyKWh) * effOneWay;
      let want = residual;
      // RULE 1 — peak levelling, economics only, never at the cost of served load
      if (LA && g.enabled && g.shaveEnabled && g.shaveTargetKW > 0) {
        const level = levelForHorizon(i, availKWh, shaveCap);
        const allowed = Math.max(0, (load[i] - pvAvail - windAvail - shaveCap) - level);
        if (allowed < want - 0.001) { want = allowed; mark(RC.HOLD_FOR_PEAK); }
      }
      const dis = Math.min(want, powerLimitKW, availKWh);
      if (dis > 0.001) {
        disKW = dis; residual -= dis;
        soc -= (dis / effOneWay) / b.energyKWh * 100;
        throughputKWh += dis;
        mark(RC.BESS_DISCHARGE);
      }
      if (residual > 0.001) {
        if (soc <= reserveFloorPct + 0.01) {
          mark(reserveFloorPct > b.socMinPct + 0.01 ? RC.SOC_RESERVE : RC.BESS_EMPTY);
        } else if (dis >= powerLimitKW - 0.001 && powerLimitKW > 0) mark(RC.BESS_POWER);
      }
      batteryDone = true;
    };

    const runThermal = () => {
      /* --- Engines --------------------------------------------------------- */
      if (e.enabled && e.units > 0) {
        const derate = 1 - Math.max(0, temp[i] - 25) * CONSTANTS.ENGINE_DERATE_PCT_PER_C_ABOVE_25 / 100;
        const unitKW = e.unitKW * derate;
        const unitMin = unitKW * e.minStableLoadPct / 100;

        const needSpinning = !g.enabled && !(b.enabled && b.gridForming && soc > reserveFloorPct + 1) && loadKW > 0;
        let desired = residual > 0.001 ? Math.ceil(residual / unitKW) : 0;
        if (needSpinning && desired === 0) desired = 1;
        desired = Math.min(desired, e.units);

        const budgetLeft = engineRunHours < e.annualHourLimit;
        if (!budgetLeft && desired > unitsOn) { desired = unitsOn; if (residual > 0.001) mark(RC.ENGINE_HOURS); }

        if (desired > unitsOn) {
          if (i - lastChangeH >= e.minDownTimeH) {
            unitsOn = desired; lastChangeH = i;
            if (e.startTimeMin > 60) { startingUntil = i + Math.ceil(e.startTimeMin / 60); mark(RC.ENGINE_START); }
          } else if (residual > 0.001) mark(RC.MIN_UP_DOWN);
        } else if (desired < unitsOn) {
          if (i - lastChangeH >= e.minUpTimeH) { unitsOn = desired; lastChangeH = i; }
        }

        const online = i < startingUntil ? 0 : unitsOn;
        if (online > 0) {
          const fleetMax = online * unitKW, fleetMin = online * unitMin;
          const outKW = Math.min(Math.max(residual, fleetMin), fleetMax);
          if (outKW > residual + 0.001) { engineExcess = outKW - residual; mark(RC.ENGINE_MIN_LOAD); }
          else mark(RC.ENGINE_ON);
          out.engine[i] = outKW;
          out.enginesOn[i] = online;
          residual = Math.max(0, residual - outKW);
          engineRunHours++;

          const loadPct = 100 * (outKW / online) / unitKW;
          if (e.fuelType === "diesel") out.fuelL[i] = outKW * partLoadValue(e.sfcDiesel, loadPct);
          else { const eff = partLoadValue(e.effGas, loadPct) / 100; out.fuelTh[i] = eff > 0 ? outKW / eff : 0; }
        }
      }

      /* --- Gas turbine ------------------------------------------------------ */
      if (t.enabled && residual > 0.001) {
        const derate = 1 - Math.max(0, temp[i] - 15) * CONSTANTS.TURBINE_DERATE_PCT_PER_C_ABOVE_15 / 100;
        const ratedKW = t.ratedKW * derate, minKW = ratedKW * t.minLoadPct / 100;
        const want = residual > 0.001;
        if (want && !turbOn && i - turbLastChangeH >= t.minDownTimeH) { turbOn = true; turbLastChangeH = i; }
        else if (!want && turbOn && i - turbLastChangeH >= t.minUpTimeH) { turbOn = false; turbLastChangeH = i; }
        if (turbOn) {
          const outKW = Math.min(Math.max(residual, minKW), ratedKW);
          if (outKW > residual + 0.001) { engineExcess += outKW - residual; mark(RC.ENGINE_MIN_LOAD); }
          else mark(RC.TURBINE_ON);
          out.turbine[i] = outKW;
          residual = Math.max(0, residual - outKW);
          turbRunHours++;
          const eff = partLoadValue(t.effCurve, 100 * outKW / ratedKW) / 100;
          out.fuelTh[i] += eff > 0 ? outKW / eff : 0;
        }
      }
    };

    /* Order for this hour. Grid import normally comes before the battery, but
       not when the stored energy is cheaper than the grid is right now: a fixed
       order would import at the evening peak while the battery sat full of
       midday solar. The test is explicit and its outcome is recorded, so the
       hour is still readable. */
    const dischargeValueEURperMWh = storedCostEURperMWh / effOneWay + wearEURperMWh;
    const batteryBeatsGrid = b.enabled && g.enabled && !thermalFirst
      && soc > reserveFloorPct + 0.01
      && price[i] > dischargeValueEURperMWh;
    /* Economic running, when it is switched on, is the one case where the
       thermal plant is offered BEFORE grid import rather than after it: the
       engine is only started because it is cheaper than the import it
       displaces. Everything else about the fleet — minimum stable load,
       minimum up and down time, the annual hour budget — is unchanged. */
    const engineBeatsGrid = engineEconomic && g.enabled && price[i] > engineStartPrice;
    if (engineBeatsGrid) engineEconomicHours++;
    if (engineBeatsGrid && batteryBeatsGrid) { runBattery(); if (disKW > 0.001) mark(RC.BESS_CHEAPER); runThermal(); runGridImport(); }
    else if (engineBeatsGrid) { runThermal(); runGridImport(); runBattery(); }
    else if (thermalFirst) { runGridImport(); runThermal(); runBattery(); }
    else if (batteryBeatsGrid) { runBattery(); if (disKW > 0.001) mark(RC.BESS_CHEAPER); runGridImport(); runThermal(); }
    else { runGridImport(); runBattery(); runThermal(); }

    /* --- Backstop import: the full connection cap, before anything is shed --- */
    if (g.enabled && residual > 0.001 && capKW > out.imp[i]) {
      const extraImp = Math.min(residual, capKW - out.imp[i]);
      if (extraImp > 0.001) { out.imp[i] += extraImp; residual -= extraImp; }
      if (residual > 0.001) mark(curtailedHour ? RC.CURTAIL_SCHED : RC.IMPORT_CAP);
    }

    /* --- Engine surplus backs off the battery before charging it ------------ */
    if (b.enabled && engineExcess > 0.001 && disKW > 0.001) {
      const back = Math.min(disKW, engineExcess);
      disKW -= back; engineExcess -= back;
      soc += (back / effOneWay) / b.energyKWh * 100;
      throughputKWh -= back;
    }

    /* --- 5. Charge the battery --------------------------------------------- */
    if (b.enabled) {
      const roomKWh = Math.max(0, (b.socMaxPct - soc) / 100 * b.energyKWh);
      let chargeKW = 0;
      if (forced) {
        // The optimiser asked for a specific charge this hour: take it from
        // surplus first, then from the grid within whatever the cap allows.
        const want = Math.max(0, -forced[i]);
        if (want > 0.001) {
          const room = Math.max(0, roomKWh / effOneWay);
          const take = Math.min(want, powerLimitKW, room);
          const fromSurplus = Math.min(surplus, take);
          surplus -= fromSurplus;
          const fromGrid = Math.min(take - fromSurplus, Math.max(0, capKW - out.imp[i]));
          chargeKW = fromSurplus + fromGrid;
          if (fromGrid > 0.001) { out.imp[i] += fromGrid; mark(RC.CHEAP_HOURS); }
          else if (chargeKW > 0.001) mark(RC.CHARGE);
        }
        if (chargeKW > 0.001) {
          soc += (chargeKW * effOneWay) / b.energyKWh * 100;
          throughputKWh += chargeKW * effOneWay;
        }
        out.bess[i] = disKW - chargeKW;
        out.soc[i] = soc;
      } else {
      // (a) surplus renewables, then any excess forced out by engine minimum load
      const fromSite = Math.min(surplus + engineExcess, powerLimitKW, roomKWh / effOneWay);
      if (fromSite > 0.001) {
        chargeKW = fromSite;
        const fromSurplus = Math.min(surplus, fromSite);
        surplus -= fromSurplus;
        engineExcess = Math.max(0, engineExcess - (fromSite - fromSurplus));
      }
      // (b) cheap grid hours, if arbitrage is enabled and the cap allows it
      // RULE 2 — charge from the grid only in the cheapest hours of the horizon,
      // and only for the room the forecast renewable surplus will not fill.
      let gridChargeKW = 0;
      const priceOK = LA ? cheapHour[i] === 1 : price[i] < meanPrice * CONSTANTS.ARBITRAGE_CHARGE_THRESHOLD;
      const roomForGrid = LA
        ? Math.max(0, roomKWh - surplusAhead[i] * effOneWay) / effOneWay
        : roomKWh / effOneWay;
      // Never charge in an hour the battery was discharging — that is churn, and
      // it pays the round-trip loss for nothing. Never charge above the
      // demand-charge target either, or the charging defeats the shaving.
      const arbCeiling = (g.shaveEnabled && g.shaveTargetKW > 0) ? Math.min(capKW, g.shaveTargetKW) : capKW;
      if (b.arbitrage && g.enabled && disKW <= 0.001 && chargeKW < powerLimitKW && priceOK) {
        const headroom = Math.max(0, arbCeiling - out.imp[i]);
        const extra = Math.min(powerLimitKW - chargeKW, headroom, Math.max(0, roomForGrid - chargeKW));
        if (extra > 0.001) {
          chargeKW += extra; gridChargeKW = extra; out.imp[i] += extra;
          if (reason === RC.RENEWABLE || reason === RC.GRID) mark(LA ? RC.CHEAP_HOURS : RC.CHARGE);
        }
      }
      if (chargeKW > 0.001) {
        const addedKWh = chargeKW * effOneWay;
        const heldKWh = Math.max(0, (soc - reserveFloorPct) / 100 * b.energyKWh);
        const addedCost = (gridChargeKW > 0.001 ? gridChargeKW / chargeKW : 0) * price[i];
        storedCostEURperMWh = (heldKWh * storedCostEURperMWh + addedKWh * addedCost) / Math.max(0.001, heldKWh + addedKWh);
        soc += addedKWh / b.energyKWh * 100;
        throughputKWh += addedKWh;
        if (reason === RC.RENEWABLE) mark(RC.CHARGE);
      }
      out.bess[i] = disKW - chargeKW;   // net: positive discharging, negative charging
      out.soc[i] = soc;
      }
    } else {
      out.bess[i] = disKW;
    }

    /* --- 6. Export or curtail ---------------------------------------------- */
    if (surplus > 0.001) {
      const exp = g.enabled ? Math.min(surplus, g.exportCapKW) : 0;
      if (exp > 0.001) { out.exp[i] = exp; surplus -= exp; if (reason === RC.RENEWABLE) mark(RC.EXPORT); }
      if (surplus > 0.001) { out.curtail[i] = surplus; curtailRenewTotal += surplus; mark(RC.CURTAIL); }
    }
    if (engineExcess > 0.001) { out.curtail[i] += engineExcess; mark(RC.ENGINE_MIN_LOAD); }

    /* --- 7. Shedding and unserved energy ------------------------------------ */
    if (residual > 0.001) {
      const t2 = Math.min(residual, loadKW * cfg.shed2Pct / 100);
      out.shed2[i] = t2; residual -= t2; if (t2 > 0.001) mark(RC.SHED_T2);
      const t1 = Math.min(residual, loadKW * cfg.shed1Pct / 100);
      out.shed1[i] = t1; residual -= t1; if (t1 > 0.001) mark(RC.SHED_T1);
      if (residual > 0.001) { out.unserved[i] = residual; mark(RC.UNSERVED); }
    }

    out.reason[i] = reason;
  }

  /* --- Summary -------------------------------------------------------------- */
  const sum = (a) => { let s = 0; for (let i = 0; i < H; i++) s += a[i]; return s; };
  const loadTotal = sum(load);
  // Renewable energy that reached the load, directly or through the battery.
  // Round-trip losses are deducted: energy charged and never discharged, or lost
  // to efficiency, never reaches the load and must not be counted as serving it.
  // Without this the fraction can exceed 100 % once storage is large, which is
  // how the omission first showed up. The total is then capped at the load,
  // since renewable energy beyond the load is exported or curtailed, not consumed.
  let bessChargeTotal = 0, bessDischargeTotal = 0;
  for (let i = 0; i < H; i++) {
    if (out.bess[i] < 0) bessChargeTotal -= out.bess[i]; else bessDischargeTotal += out.bess[i];
  }
  const bessLossTotal = Math.max(0, bessChargeTotal - bessDischargeTotal);
  // Auxiliaries are consumption too, and renewable energy serves them, so they
  // belong in the denominator. Omitting them inflates the share at high
  // penetration, where nearly all of the auxiliary demand is renewable-served.
  const consumptionTotal = loadTotal + sum(out.aux);
  const renewToLoadTotal = Math.min(consumptionTotal,
    sum(out.pv) + sum(out.wind) - curtailRenewTotal - sum(out.exp) - bessLossTotal);
  const engineHours = out.enginesOn.reduce((a, v) => a + (v > 0 ? 1 : 0), 0);
  const engineUnitHours = out.enginesOn.reduce((a, v) => a + v, 0);
  const reasonCount = new Array(REASON_CODES.length).fill(0);
  for (let i = 0; i < H; i++) reasonCount[out.reason[i]]++;

  // European kW-max charges are billed on each month's peak, not the annual one.
  // Billing on the annual peak alone understates what a battery is worth, because
  // it only ever gets credit for flattening one hour of the year.
  const monthlyPeakKW = new Array(12).fill(0);
  for (let i = 0; i < H; i++) if (out.imp[i] > monthlyPeakKW[cal.month[i]]) monthlyPeakKW[cal.month[i]] = out.imp[i];
  const meanMonthlyPeakKW = monthlyPeakKW.reduce((a, v) => a + v, 0) / 12;

  return {
    ...out,
    summary: {
      loadMWh: loadTotal / 1000,
      pvMWh: sum(out.pv) / 1000,
      windMWh: sum(out.wind) / 1000,
      importMWh: sum(out.imp) / 1000,
      exportMWh: sum(out.exp) / 1000,
      engineMWh: sum(out.engine) / 1000,
      turbineMWh: sum(out.turbine) / 1000,
      curtailMWh: sum(out.curtail) / 1000,
      unservedMWh: sum(out.unserved) / 1000,
      shed1MWh: sum(out.shed1) / 1000,
      shed2MWh: sum(out.shed2) / 1000,
      fuelLitres: sum(out.fuelL),
      fuelMWhTh: sum(out.fuelTh) / 1000,
      engineHours, engineUnitHours,
      engineMarginalEURperMWh: isFinite(engineMarginalEURperMWh) ? engineMarginalEURperMWh : 0,
      engineEconomicHours,
      engineEconomic,
      renewableFraction: consumptionTotal > 0 ? Math.max(0, renewToLoadTotal) / consumptionTotal : 0,
      curtailmentRate: (sum(out.pv) + sum(out.wind)) > 0 ? curtailRenewTotal / (sum(out.pv) + sum(out.wind)) : 0,
      curtailRenewMWh: curtailRenewTotal / 1000,
      curtailEngineMWh: (sum(out.curtail) - curtailRenewTotal) / 1000,
      renewDirectMWh: renewServedTotal / 1000,
      equivalentFullCycles: b.enabled && b.energyKWh > 0 ? throughputKWh / 2 / b.energyKWh : 0,
      minSoc: b.enabled ? Math.min(...Array.from(out.soc)) : 0,
      peakImportKW: Math.max(...Array.from(out.imp)),
      monthlyPeakKW, meanMonthlyPeakKW,
      hoursAboveShaveTarget: g.shaveEnabled && g.shaveTargetKW > 0 ? out.imp.reduce((a, v) => a + (v > g.shaveTargetKW + 0.001 ? 1 : 0), 0) : 0,
      reasonCount,
    },
  };
}

/* ============================================================================
   PHASE 3 ENGINE — adequacy checks
   Three independent verdicts. They are never combined into a single score:
   a design that fails dynamic adequacy is not viable because energy passes.
   ========================================================================== */

const verdict = (pass, marginal) => (pass ? "PASS" : marginal ? "MARGINAL" : "FAIL");

/**
 * 1. ENERGY ADEQUACY — is there enough energy over the year, and enough stored
 *    energy to ride through the required island?
 */
function assessEnergyAdequacy(a) {
  const { disp, load, cal, bess, ctx, islandLoadKW, engineFirmKW } = a;
  const s = disp.summary;

  const unservedPct = s.loadMWh > 0 ? 100 * s.unservedMWh / s.loadMWh : 0;
  const shedMWh = s.shed1MWh + s.shed2MWh;

  // Stored energy available for an island, in kWh at the busbar.
  // Unplanned islanding can only use what the reserve holds; planned islanding
  // can charge to the top of the SOC window first.
  const effOneWay = Math.sqrt(bess.rteFraction);
  const usableWindowPct = ctx.islanding === "planned"
    ? bess.socMaxPct - bess.socMinPct
    : Math.max(0, bess.reserveSocPct - bess.socMinPct);
  const islandKWh = bess.enabled ? bess.energyKWh * usableWindowPct / 100 * effOneWay : 0;
  const autonomyFromBessH = islandLoadKW > 0 ? islandKWh / islandLoadKW : 0;
  const enginesCarryIsland = engineFirmKW >= islandLoadKW;

  // Worst renewable spell — the window where renewables cover least of the load.
  const W = CONSTANTS.LOW_RENEWABLE_WINDOW_H;
  let bestGen = 0, bestLoad = 0, worstRatio = Infinity, worstStart = 0;
  let genSum = 0, loadSum = 0;
  for (let i = 0; i < H; i++) {
    genSum += disp.pv[i] + disp.wind[i];
    loadSum += load[i];
    if (i >= W) { genSum -= disp.pv[i - W] + disp.wind[i - W]; loadSum -= load[i - W]; }
    if (i >= W - 1 && loadSum > 0) {
      const ratio = genSum / loadSum;
      if (ratio < worstRatio) { worstRatio = ratio; worstStart = i - W + 1; bestGen = genSum; bestLoad = loadSum; }
    }
  }
  const worstDeficitMWh = (bestLoad - bestGen) / 1000;

  const autonomyOK = ctx.islanding === "none" || autonomyFromBessH >= ctx.autonomyH || enginesCarryIsland;
  const energyOK = unservedPct <= CONSTANTS.UNSERVED_ENERGY_TOLERANCE_PCT;
  const pass = energyOK && autonomyOK;
  const marginal = energyOK && !autonomyOK && autonomyFromBessH >= ctx.autonomyH * 0.75;

  return {
    verdict: verdict(pass, marginal),
    governing: !energyOK
      ? `${s.unservedMWh.toFixed(1)} MWh/yr unserved (${unservedPct.toFixed(3)} % of load)`
      : !autonomyOK
        ? `${autonomyFromBessH.toFixed(1)} h autonomy against ${ctx.autonomyH} h required`
        : `${s.unservedMWh.toFixed(2)} MWh unserved, ${autonomyFromBessH.toFixed(1)} h autonomy`,
    unservedMWh: s.unservedMWh, unservedPct, shedMWh,
    autonomyFromBessH, autonomyRequiredH: ctx.autonomyH, islandKWh, islandLoadKW,
    enginesCarryIsland, engineFirmKW,
    worstWindowH: W, worstRenewableShare: worstRatio === Infinity ? 0 : worstRatio,
    worstWindowStart: worstStart, worstDeficitMWh,
    worstWindowLabel: `${dayLabel(cal.doy[worstStart])} ${String(cal.hourOfDay[worstStart]).padStart(2, "0")}h`,
  };
}

/**
 * 2. POWER ADEQUACY — firm capacity against coincident peak, with N-1 applied.
 *    Renewables contribute no firm capacity. The battery contributes its rated
 *    power only while it holds energy, which is flagged rather than assumed.
 */
function assessPowerAdequacy(a) {
  const { peakKW, parasiticKW, grid, bess, engine, turbine, gridFormingSource, applyN1 } = a;
  const coincidentPeakKW = peakKW + parasiticKW;

  const units = [];
  if (grid.enabled) units.push({ name: "Grid connection", kW: grid.firmCapKW, kind: "grid", gridForming: gridFormingSource === "grid" });
  if (engine.enabled) for (let i = 0; i < engine.units; i++)
    units.push({ name: `Engine unit ${i + 1}`, kW: engine.unitKW, kind: "engine", gridForming: false });
  if (turbine.enabled) units.push({ name: "Gas turbine", kW: turbine.ratedKW, kind: "turbine", gridForming: false });
  if (bess.enabled) units.push({ name: "BESS", kW: bess.powerKW, kind: "bess", gridForming: gridFormingSource === "bess" });

  const firmKW = units.reduce((t, u) => t + u.kW, 0);
  const largest = units.reduce((m, u) => (u.kW > (m?.kW || 0) ? u : m), null);
  const firmAfterN1KW = firmKW - (largest?.kW || 0);
  // N-1 is only the right test where the site must survive losing a source. A
  // grid-connected site with no islanding requirement is not designed to run
  // without its connection, so holding it to N-1 rejects every sensible design.
  const marginKW = (applyN1 ? firmAfterN1KW : firmKW) - coincidentPeakKW;

  const losesGridForming = !!applyN1 && !!largest?.gridForming;
  // No firm capacity at all is a failure, not a pass with a zero margin.
  const pass = units.length > 0 && coincidentPeakKW > 0
    && marginKW >= coincidentPeakKW * CONSTANTS.N_MINUS_1_MARGIN_PCT / 100 && !losesGridForming;
  const marginal = marginKW >= 0 && losesGridForming;

  return {
    verdict: verdict(pass, marginal),
    governing: marginKW < 0
      ? (applyN1
        ? `${(marginKW / 1000).toFixed(2)} MW short after losing ${largest ? largest.name : "the largest unit"}`
        : `${(marginKW / 1000).toFixed(2)} MW short of the coincident peak`)
      : losesGridForming
        ? `${(marginKW / 1000).toFixed(2)} MW spare, but losing ${largest ? largest.name : "the largest unit"} also loses the grid-forming source`
        : !applyN1
          ? `${(marginKW / 1000).toFixed(2)} MW spare at the coincident peak; N-1 not applied because the site has no islanding requirement`
          : largest
            ? `${(marginKW / 1000).toFixed(2)} MW spare after losing ${largest.name}`
            : "No firm capacity installed — nothing to lose, and nothing to serve the peak",
    coincidentPeakKW, parasiticKW, firmKW, firmAfterN1KW, marginKW, applyN1,
    largestUnit: largest, losesGridForming, units,
  };
}

/**
 * 3. DYNAMIC ADEQUACY — can the island absorb the largest load step and the
 *    largest motor start without an unacceptable frequency excursion?
 *
 *    RoCoF = ΔP · f₀ / (2 · Σ Hᵢ·Sᵢ)   with the step net of instantaneous
 *    grid-forming response. Nadir is estimated as RoCoF × governor response
 *    time — a first-order figure, not a substitute for an EMT study.
 */
function assessDynamicAdequacy(a) {
  const { stepKW, motorKW, motorMethod, bess, engine, turbine, islanded, disp, islandLoadKW } = a;

  // Units expected to be online when the step arrives. Two sources: the most
  // the dispatch ever ran, and — in an island — the number needed to carry the
  // critical load, because those units are necessarily running and their step
  // acceptance is therefore available. Taking only the dispatch maximum would
  // credit one engine in a grid-connected year and fail a design that is fine.
  let maxEnginesOn = 0;
  for (let i = 0; i < H; i++) if (disp.enginesOn[i] > maxEnginesOn) maxEnginesOn = disp.enginesOn[i];
  const neededForIsland = islanded && engine.enabled && engine.unitKW > 0
    ? Math.min(engine.units, Math.ceil(islandLoadKW / engine.unitKW)) : 0;
  const enginesOnline = engine.enabled ? Math.min(engine.units, Math.max(maxEnginesOn, neededForIsland)) : 0;

  // Fast response available, kW
  const bessStepKW = bess.enabled && bess.gridForming ? bess.powerKW * bess.gridFormingStepPct / 100 : 0;
  const engineStepKW = engine.enabled ? enginesOnline * engine.unitKW * engine.stepAcceptancePct / 100 : 0;
  const turbineStepKW = turbine.enabled ? turbine.ratedKW * CONSTANTS.ENGINE_STEP_ACCEPTANCE_PCT / 100 : 0;
  const fastResponseKW = bessStepKW + engineStepKW + turbineStepKW;

  // Motor starting appears as apparent power, several times its rating
  const inrush = CONSTANTS.MOTOR_INRUSH_FACTOR[motorMethod] || 6;
  const motorStepKW = motorKW * inrush;
  const worstStepKW = Math.max(stepKW, motorStepKW);

  // System inertia — only rotating plant contributes. A grid-forming battery
  // supplies power fast but no stored kinetic energy.
  const engineMVA = enginesOnline * engine.unitKW / CONSTANTS.GENERATOR_POWER_FACTOR / 1000;
  const turbineMVA = turbine.enabled ? turbine.ratedKW / CONSTANTS.GENERATOR_POWER_FACTOR / 1000 : 0;
  const inertiaMWs = engineMVA * CONSTANTS.INERTIA_H_ENGINE_S + turbineMVA * CONSTANTS.INERTIA_H_TURBINE_S;

  const deficitMW = Math.max(0, worstStepKW - fastResponseKW) / 1000;
  const rocof = inertiaMWs > 0 ? deficitMW * CONSTANTS.NOMINAL_FREQUENCY_HZ / (2 * inertiaMWs) : (deficitMW > 0 ? Infinity : 0);
  const nadirHz = rocof === Infinity ? Infinity : rocof * CONSTANTS.GOVERNOR_RESPONSE_TIME_S;

  const pass = !islanded || (deficitMW <= 0 && rocof <= CONSTANTS.ROCOF_PASS_HZ_PER_S)
    || (rocof <= CONSTANTS.ROCOF_PASS_HZ_PER_S && nadirHz <= CONSTANTS.FREQ_NADIR_PASS_HZ);
  const marginal = !pass && rocof <= CONSTANTS.ROCOF_MARGINAL_HZ_PER_S && nadirHz <= CONSTANTS.FREQ_NADIR_MARGINAL_HZ;

  return {
    verdict: islanded ? verdict(pass, marginal) : "PASS",
    governing: !islanded
      ? "Grid-connected — the network absorbs the step; island case not required"
      : deficitMW <= 0
        ? `${(worstStepKW / 1000).toFixed(2)} MW step fully covered by ${(fastResponseKW / 1000).toFixed(2)} MW of fast response`
        : `${(deficitMW).toFixed(2)} MW uncovered → RoCoF ${rocof === Infinity ? "no inertia" : rocof.toFixed(2) + " Hz/s"}, nadir ${nadirHz === Infinity ? "collapse" : "−" + nadirHz.toFixed(2) + " Hz"}`,
    worstStepKW, loadStepKW: stepKW, motorStepKW, motorMethod, inrush,
    fastResponseKW, bessStepKW, engineStepKW, turbineStepKW,
    enginesOnline, inertiaMWs, deficitMW, rocof, nadirHz, islanded,
  };
}

/** Bill of materials — quantities only. Costs arrive in Phase 4. */
function buildBOM(a) {
  const { res, ctx, grid, disp, aidcLimits } = a;
  const rows = [];
  if (res.pv.enabled) {
    rows.push({ item: "PV array", qty: 1, rating: `${(res.pv.kWp / 1000).toFixed(2)} MWp DC`, note: `DC/AC ${res.pv.dcacRatio.toFixed(2)}` });
    rows.push({ item: "PV inverters", qty: 1, rating: `${(res.pv.kWp / res.pv.dcacRatio / 1000).toFixed(2)} MW AC`, note: `${disp.summary.pvMWh.toFixed(0)} MWh/yr generated` });
  }
  if (res.wind.enabled) rows.push({ item: "Wind turbines", qty: 1, rating: `${(res.wind.ratedKW / 1000).toFixed(2)} MW`, note: `hub ${res.wind.hubHeightM} m` });
  if (res.bess.enabled) {
    rows.push({ item: "BESS power conversion", qty: 1, rating: `${(res.bess.powerKW / 1000).toFixed(2)} MW`, note: res.bess.gridForming ? "grid-forming" : "grid-following" });
    rows.push({ item: "BESS energy", qty: 1, rating: `${(res.bess.energyKWh / 1000).toFixed(2)} MWh`, note: `${(res.bess.energyKWh / Math.max(1, res.bess.powerKW)).toFixed(2)} h duration, ${disp.summary.equivalentFullCycles.toFixed(0)} EFC/yr` });
  }
  if (res.engine.enabled) rows.push({ item: `${res.engine.fuelType === "gas" ? "Gas" : "Diesel"} engines`, qty: res.engine.units, rating: `${(res.engine.unitKW / 1000).toFixed(2)} MW each`, note: `${(res.engine.units * res.engine.unitKW / 1000).toFixed(2)} MW total, ${disp.summary.engineHours} h/yr` });
  if (res.turbine.enabled) rows.push({ item: "Gas turbine", qty: 1, rating: `${(res.turbine.ratedKW / 1000).toFixed(2)} MW site-rated`, note: "not ISO rating" });
  if (grid.enabled) rows.push({ item: "Grid connection", qty: 1, rating: `${(grid.firmCapKW / 1000).toFixed(2)} MW import`, note: `${(ctx.exportCapKW / 1000).toFixed(2)} MW export, peak used ${(disp.summary.peakImportKW / 1000).toFixed(2)} MW` });

  const pvArea = res.pv.enabled ? res.pv.kWp * (aidcLimits?.pvAreaPerKWp || CONSTANTS.PV_AREA_M2_PER_KWP) : 0;
  const bessArea = res.bess.enabled ? res.bess.powerKW / 1000 * (aidcLimits?.bessFootprint || CONSTANTS.BESS_FOOTPRINT_M2_PER_MW) : 0;
  const engineArea = res.engine.enabled ? res.engine.units * res.engine.unitKW / 1000 * (aidcLimits?.engineFootprint || CONSTANTS.ENGINE_FOOTPRINT_M2_PER_MW) : 0;

  return {
    rows,
    installedMW: ((res.pv.enabled ? res.pv.kWp / res.pv.dcacRatio : 0) + (res.wind.enabled ? res.wind.ratedKW : 0)
      + (res.bess.enabled ? res.bess.powerKW : 0) + (res.engine.enabled ? res.engine.units * res.engine.unitKW : 0)
      + (res.turbine.enabled ? res.turbine.ratedKW : 0)) / 1000,
    pvAreaM2: pvArea, bessAreaM2: bessArea, engineAreaM2: engineArea,
    totalAreaM2: pvArea + bessArea + engineArea,
  };
}

/* ============================================================================
   ENGINE SELF-TEST
   Speed is not evidence. These checks re-derive, from the stored hourly arrays
   alone, every physical constraint the dispatch claims to respect. They read
   the OUTPUT, not the code that produced it, so a logic error in the dispatch
   cannot hide behind them. Any failure is reported with the hour it occurred.
   ========================================================================== */
function selfTest(disp, inp, cal) {
  const b = inp.bess, e = inp.engine, g = inp.grid, t = inp.turbine;
  const checks = [];
  const tol = 0.5; // kW — floating point tolerance on a per-hour balance

  const record = (name, detail, worst, worstHour, fails) =>
    checks.push({ name, detail, pass: fails === 0, fails, worst, worstHour });

  /* 1. Hourly energy balance — every kW accounted for, every hour */
  let worstBal = 0, worstBalH = -1, balFails = 0;
  for (let i = 0; i < H; i++) {
    const sources = disp.pv[i] + disp.wind[i] + disp.imp[i] + disp.engine[i] + disp.turbine[i] + Math.max(0, disp.bess[i]);
    const servedLoad = inp.load[i] - disp.unserved[i] - disp.shed1[i] - disp.shed2[i];
    const sinks = servedLoad + disp.exp[i] + disp.curtail[i] + Math.max(0, -disp.bess[i]) + disp.aux[i];
    const r = Math.abs(sources - sinks);
    if (r > worstBal) { worstBal = r; worstBalH = i; }
    if (r > tol) balFails++;
  }
  record("Hourly energy balance closes", "generation + import + discharge = served load + charge + export + curtailment + auxiliaries",
    `${worstBal.toFixed(4)} kW worst residual`, worstBalH, balFails);

  /* 2. State of charge stays inside the declared window */
  let socFails = 0, worstSoc = 0, worstSocH = -1;
  if (b.enabled) for (let i = 0; i < H; i++) {
    const over = Math.max(disp.soc[i] - b.socMaxPct, b.socMinPct - disp.soc[i]);
    if (over > worstSoc) { worstSoc = over; worstSocH = i; }
    if (over > 0.01) socFails++;
  }
  record("SOC within its window", `${b.socMinPct}–${b.socMaxPct} % of nameplate`,
    b.enabled ? `${worstSoc.toFixed(3)} % worst excursion` : "battery not in service", worstSocH, socFails);

  /* 3. SOC moves exactly as the charge and discharge say it should */
  let contFails = 0, worstCont = 0, worstContH = -1;
  if (b.enabled && b.energyKWh > 0) {
    const eff = Math.sqrt(b.rteFraction);
    for (let i = 1; i < H; i++) {
      const dis = Math.max(0, disp.bess[i]), chg = Math.max(0, -disp.bess[i]);
      const expected = disp.soc[i - 1] + (chg * eff - dis / eff) / b.energyKWh * 100;
      const d = Math.abs(expected - disp.soc[i]);
      if (d > worstCont) { worstCont = d; worstContH = i; }
      if (d > 0.01) contFails++;
    }
  }
  record("SOC continuity", "each hour's SOC follows from the previous hour and the energy moved, at √RTE each way",
    b.enabled ? `${worstCont.toFixed(4)} % worst drift` : "battery not in service", worstContH, contFails);

  /* 4. Import never exceeds the cap in force */
  let impFails = 0, worstImp = 0, worstImpH = -1;
  for (let i = 0; i < H; i++) {
    const cap = !g.enabled ? 0 : (g.nonFirm && g.curtailFlags[i] ? g.reducedCapKW : g.importCapKW);
    const over = disp.imp[i] - cap;
    if (over > worstImp) { worstImp = over; worstImpH = i; }
    if (over > tol) impFails++;
  }
  record("Import within the connection cap", g.enabled ? `${(g.importCapKW / 1000).toFixed(2)} MW${g.nonFirm ? `, reduced to ${(g.reducedCapKW / 1000).toFixed(2)} MW when curtailed` : ""}` : "no connection",
    `${worstImp.toFixed(3)} kW worst overshoot`, worstImpH, impFails);

  /* 5. Export never exceeds its cap */
  let expFails = 0, worstExp = 0, worstExpH = -1;
  for (let i = 0; i < H; i++) {
    const over = disp.exp[i] - (g.enabled ? g.exportCapKW : 0);
    if (over > worstExp) { worstExp = over; worstExpH = i; }
    if (over > tol) expFails++;
  }
  record("Export within its cap", `${g.enabled ? (g.exportCapKW / 1000).toFixed(2) : 0} MW`, `${worstExp.toFixed(3)} kW worst overshoot`, worstExpH, expFails);

  /* 6. Engines never run below minimum stable load, never above rating */
  let engFails = 0, worstEng = 0, worstEngH = -1;
  if (e.enabled) for (let i = 0; i < H; i++) {
    const on = disp.enginesOn[i];
    if (on === 0) { if (disp.engine[i] > tol) { engFails++; } continue; }
    const derate = 1 - Math.max(0, inp.temp[i] - 25) * CONSTANTS.ENGINE_DERATE_PCT_PER_C_ABOVE_25 / 100;
    const unit = e.unitKW * derate;
    const lo = on * unit * e.minStableLoadPct / 100, hi = on * unit;
    const viol = Math.max(lo - disp.engine[i], disp.engine[i] - hi);
    if (viol > worstEng) { worstEng = viol; worstEngH = i; }
    if (viol > tol) engFails++;
  }
  record("Engines between minimum stable load and rating", e.enabled ? `${e.minStableLoadPct} % to 100 % of the ambient-derated unit rating` : "engines not in service",
    `${worstEng.toFixed(3)} kW worst violation`, worstEngH, engFails);

  /* 7. Turbine minimum load */
  let turbFails = 0, worstTurb = 0, worstTurbH = -1;
  if (t.enabled) for (let i = 0; i < H; i++) {
    if (disp.turbine[i] <= tol) continue;
    const derate = 1 - Math.max(0, inp.temp[i] - 15) * CONSTANTS.TURBINE_DERATE_PCT_PER_C_ABOVE_15 / 100;
    const lo = t.ratedKW * derate * t.minLoadPct / 100, hi = t.ratedKW * derate;
    const viol = Math.max(lo - disp.turbine[i], disp.turbine[i] - hi);
    if (viol > worstTurb) { worstTurb = viol; worstTurbH = i; }
    if (viol > tol) turbFails++;
  }
  record("Turbine above its minimum load", t.enabled ? `${t.minLoadPct} % of the site rating` : "turbine not in service",
    `${worstTurb.toFixed(3)} kW worst violation`, worstTurbH, turbFails);

  /* 8. The resilience reserve is a hard floor when islanding is required */
  let resFails = 0, worstRes = 0, worstResH = -1;
  if (b.enabled && b.reserveApplies) {
    const floor = Math.max(b.socMinPct, b.reserveSocPct);
    for (let i = 0; i < H; i++) {
      const below = floor - disp.soc[i];
      if (below > worstRes) { worstRes = below; worstResH = i; }
      if (below > 0.01) resFails++;
    }
  }
  record("Resilience reserve never breached", b.enabled && b.reserveApplies ? `floor at ${Math.max(b.socMinPct, b.reserveSocPct)} % SOC` : "not enforced for this configuration",
    `${worstRes.toFixed(3)} % worst breach`, worstResH, resFails);

  /* 9. Nothing negative anywhere */
  let negFails = 0, negH = -1;
  for (let i = 0; i < H; i++) {
    if (disp.pv[i] < -tol || disp.wind[i] < -tol || disp.imp[i] < -tol || disp.exp[i] < -tol
      || disp.engine[i] < -tol || disp.turbine[i] < -tol || disp.curtail[i] < -tol
      || disp.unserved[i] < -tol || disp.shed1[i] < -tol || disp.shed2[i] < -tol) { negFails++; if (negH < 0) negH = i; }
  }
  record("No negative flows", "every recorded flow is physically signed", `${negFails} hour(s)`, negH, negFails);

  /* 10. Curtailment never exceeds what was available to curtail */
  let curtFails = 0, worstCurt = 0, worstCurtH = -1;
  for (let i = 0; i < H; i++) {
    const available = disp.pv[i] + disp.wind[i] + disp.engine[i] + disp.turbine[i];
    const over = disp.curtail[i] - available;
    if (over > worstCurt) { worstCurt = over; worstCurtH = i; }
    if (over > tol) curtFails++;
  }
  record("Curtailment never exceeds generation", "you cannot throw away more than was produced",
    `${worstCurt.toFixed(3)} kW worst excess`, worstCurtH, curtFails);

  /* 11. Unserved energy only when every source was genuinely exhausted */
  let unsFails = 0, unsH = -1, unsHours = 0;
  // Engine availability is re-derived here, not taken from the dispatch: the
  // permitted annual hours may be used up, or a unit may still be inside its
  // minimum down time after stopping. Both make "no engine" a legitimate state.
  const engHoursUsedBefore = new Int32Array(H);
  let acc = 0;
  for (let i = 0; i < H; i++) { engHoursUsedBefore[i] = acc; if (disp.enginesOn[i] > 0) acc++; }
  for (let i = 0; i < H; i++) {
    if (disp.unserved[i] <= tol) continue;
    unsHours++;
    const budgetGone = e.enabled && engHoursUsedBefore[i] >= e.annualHourLimit;
    let inDownTime = false;
    if (e.enabled && e.minDownTimeH > 0) {
      for (let k = Math.max(0, i - e.minDownTimeH); k < i; k++) if (disp.enginesOn[k] > 0) { inDownTime = true; break; }
      inDownTime = inDownTime && disp.enginesOn[i] === 0;
    }
    const cap = !g.enabled ? 0 : (g.nonFirm && g.curtailFlags[i] ? g.reducedCapKW : g.importCapKW);
    const gridExhausted = !g.enabled || disp.imp[i] >= cap - tol;
    const floor = b.reserveApplies ? Math.max(b.socMinPct, b.reserveSocPct) : b.socMinPct;
    const bessExhausted = !b.enabled || disp.soc[i] <= floor + 0.01 || Math.max(0, disp.bess[i]) >= Math.min(b.powerKW, b.energyKWh * b.cRate) - tol;
    const engExhausted = !e.enabled || budgetGone || inDownTime
      || disp.enginesOn[i] >= e.units || disp.engine[i] >= e.units * e.unitKW - tol;
    if (!(gridExhausted && bessExhausted && engExhausted)) { unsFails++; if (unsH < 0) unsH = i; }
  }
  record("Unserved energy only when every source is exhausted",
    `${unsHours} hour(s) with unserved energy; engine hour budget and minimum down time counted as legitimate unavailability`,
    `${unsFails} unjustified hour(s)`, unsH, unsFails);

  /* 12. Annual totals reconcile with the hourly arrays */
  let sumLoad = 0, sumSources = 0, sumSinks = 0;
  for (let i = 0; i < H; i++) {
    sumLoad += inp.load[i];
    sumSources += disp.pv[i] + disp.wind[i] + disp.imp[i] + disp.engine[i] + disp.turbine[i] + Math.max(0, disp.bess[i]);
    sumSinks += (inp.load[i] - disp.unserved[i] - disp.shed1[i] - disp.shed2[i]) + disp.exp[i] + disp.curtail[i]
      + Math.max(0, -disp.bess[i]) + disp.aux[i];
  }
  const annualResidualPct = sumLoad > 0 ? 100 * Math.abs(sumSources - sumSinks) / sumLoad : 0;
  record("Annual totals reconcile", "the 8760 hourly rows sum to the annual figures reported",
    `${annualResidualPct.toFixed(6)} % of annual load`, -1, annualResidualPct > 0.001 ? 1 : 0);

  const failed = checks.filter((c) => !c.pass).length;
  return { checks, failed, passed: checks.length - failed, total: checks.length };
}

/* ============================================================================
   DISPATCH QUALITY — how far from the best possible dispatch?
   A rule-based dispatch cannot claim optimality. What it can do is state how
   much room is left. This computes a strict LOWER BOUND on annual operating
   cost for the same assets, by relaxing every temporal and unit constraint:
     · perfect foresight over the whole year
     · storage is free, lossless and unlimited in energy (any surplus can be
       moved to any hour), so no renewable is ever curtailed
     · engines have no minimum stable load, no start time, no up/down time
     · energy is bought in the cheapest hours the import cap allows
   No dispatch — not a MILP, not a human operator — can beat this number.
   The gap between it and the actual dispatch is the most that better logic
   could ever be worth.
   ========================================================================== */
function operatingCostBound(a) {
  const { load, pvGen, windGen, price, grid, engine, loc, costs } = a;

  let totalLoadKWh = 0, totalRenewKWh = 0;
  for (let i = 0; i < H; i++) {
    totalLoadKWh += load[i];
    totalRenewKWh += (pvGen ? pvGen[i] : 0) + (windGen ? windGen[i] : 0);
  }
  // Free, lossless, unlimited storage means every renewable kWh is usable,
  // up to total demand.
  const renewUsedKWh = Math.min(totalRenewKWh, totalLoadKWh);
  let remainingKWh = totalLoadKWh - renewUsedKWh;

  // Buy the remainder in the cheapest hours the connection allows.
  let gridCost = 0, gridKWh = 0;
  if (grid.enabled && grid.importCapKW > 0) {
    const order = Array.from({ length: H }, (_, i) => i).sort((x, y) => price[x] - price[y]);
    for (const i of order) {
      if (remainingKWh <= 0) break;
      const take = Math.min(grid.importCapKW, remainingKWh);
      gridCost += take * price[i] / 1000;
      gridKWh += take;
      remainingKWh -= take;
    }
  }

  // Anything the connection cannot carry runs on fuel, at best-point efficiency
  // and with no minimum-load penalty.
  const engineMarginal = engine.fuelType === "diesel"
    ? 1000 * partLoadValue(CONSTANTS.DIESEL_SFC_L_PER_KWH, 75) * loc.diesel_EUR_per_litre
    : loc.gas_EUR_per_MWh_th / (partLoadValue(CONSTANTS.GAS_ENGINE_EFF_PCT, 100) / 100);
  const engineKWh = Math.max(0, remainingKWh);
  const engineCost = engineKWh / 1000 * engineMarginal;

  return {
    boundEUR: gridCost + engineCost,
    renewUsedMWh: renewUsedKWh / 1000,
    gridMWh: gridKWh / 1000, gridCost,
    engineMWh: engineKWh / 1000, engineCost,
    engineMarginal,
    infeasible: remainingKWh > 0 && !engine.enabled,
  };
}

/** Actual variable operating cost of a dispatch, on the same basis as the bound. */
function operatingCostActual(disp, price, loc, engine) {
  let gridCost = 0;
  for (let i = 0; i < H; i++) gridCost += disp.imp[i] * price[i] / 1000;
  const fuelCost = engine.fuelType === "diesel"
    ? disp.summary.fuelLitres * loc.diesel_EUR_per_litre
    : disp.summary.fuelMWhTh * loc.gas_EUR_per_MWh_th;
  return { totalEUR: gridCost + fuelCost, gridCost, fuelCost };
}

/**
 * DISPATCH DIAGNOSTICS — hindsight tests for myopia.
 *
 * The lower bound above relaxes storage entirely, so for a storage-limited
 * off-grid system it is a weak bound and a large gap says more about the
 * relaxation than about the dispatch. These tests are tighter, because each
 * one looks for a specific decision the dispatch could demonstrably have made
 * better, using only what actually happened.
 */
function dispatchDiagnostics(disp, inp, loc) {
  const b = inp.bess, g = inp.grid;
  const powerLimitKW = b.enabled ? Math.min(b.powerKW, b.energyKWh * b.cRate) : 0;
  const floor = b.reserveApplies ? Math.max(b.socMinPct, b.reserveSocPct) : b.socMinPct;

  // 1. Renewable energy thrown away while the battery had both room and power.
  //    Anything here is avoidable waste — either myopia, or a power limit.
  let curtailedWithRoomKWh = 0, curtailedWithRoomHours = 0;
  for (let i = 0; i < H; i++) {
    if (disp.curtail[i] <= 0.5 || !b.enabled) continue;
    const roomKWh = Math.max(0, (b.socMaxPct - disp.soc[i]) / 100 * b.energyKWh);
    const powerFree = Math.max(0, powerLimitKW - Math.max(0, -disp.bess[i]));
    const absorbable = Math.min(disp.curtail[i], roomKWh, powerFree);
    if (absorbable > 0.5) { curtailedWithRoomKWh += absorbable; curtailedWithRoomHours++; }
  }

  // 2. Best achievable peak import for this battery, by water-filling each day:
  //    the lowest level L such that on every day the energy above L fits in the
  //    usable capacity and the height above L fits within rated power. This is
  //    a bound no dispatch policy can beat, and the gap to it is the prize for
  //    better logic — priced at the site capacity charge.
  let achievablePeakKW = 0, achievedPeakKW = 0;
  for (let i = 0; i < H; i++) if (disp.imp[i] > achievedPeakKW) achievedPeakKW = disp.imp[i];
  if (g.enabled && b.enabled) {
    const usableKWh = b.energyKWh * (b.socMaxPct - floor) / 100 * Math.sqrt(b.rteFraction);
    const resid = new Float32Array(H);
    let maxResid = 0;
    for (let i = 0; i < H; i++) {
      resid[i] = Math.max(0, inp.load[i] - (inp.pvGen ? inp.pvGen[i] : 0) - (inp.windGen ? inp.windGen[i] : 0));
      if (resid[i] > maxResid) maxResid = resid[i];
    }
    const feasible = (L) => {
      for (let d = 0; d < 365; d++) {
        let e = 0, hgt = 0;
        for (let h = 0; h < 24; h++) {
          const over = resid[d * 24 + h] - L;
          if (over > 0) { e += over; if (over > hgt) hgt = over; }
        }
        if (e > usableKWh || hgt > powerLimitKW) return false;
      }
      return true;
    };
    let lo = Math.max(0, maxResid - powerLimitKW), hi = maxResid;
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (feasible(mid)) hi = mid; else lo = mid; }
    achievablePeakKW = hi;
  }
  const peakGapKW = Math.max(0, achievedPeakKW - achievablePeakKW);
  const peakGapEUR = peakGapKW * loc.capacityCharge_EUR_per_kW_yr;

  // 3. Ceiling on what price arbitrage could ever be worth: on each day, the
  //    battery cannot capture more than the day's price spread on the energy it
  //    can physically move. Closed form, no optimisation.
  let arbitrageCeilingEUR = 0;
  if (b.enabled && g.enabled) {
    const eff = b.rteFraction;
    const usableKWh = b.energyKWh * (b.socMaxPct - floor) / 100;
    const movableKWh = Math.min(usableKWh, powerLimitKW * 24);
    for (let d = 0; d < 365; d++) {
      let lo = Infinity, hi = -Infinity;
      for (let h = 0; h < 24; h++) { const p = inp.price[d * 24 + h]; if (p < lo) lo = p; if (p > hi) hi = p; }
      arbitrageCeilingEUR += Math.max(0, hi * eff - lo) * movableKWh / 1000;
    }
  }

  // 4. Engine energy dumped because a unit could not turn down. Sizing, not logic.
  const engineDumpMWh = disp.summary.curtailEngineMWh;

  const findings = [
    {
      name: "Renewables wasted while the battery had room",
      value: `${(curtailedWithRoomKWh / 1000).toFixed(1)} MWh over ${curtailedWithRoomHours} h`,
      good: curtailedWithRoomKWh / 1000 < 0.1,
      note: "anything above zero is energy a better-informed dispatch could have stored",
    },
    {
      name: "Peak import against the best this battery could achieve",
      value: `${(achievedPeakKW / 1000).toFixed(2)} MW against a floor of ${(achievablePeakKW / 1000).toFixed(2)} MW — ${(peakGapKW / 1000).toFixed(2)} MW, worth ${(peakGapEUR / 1000).toFixed(1)} k€/yr`,
      good: peakGapKW < 0.02 * Math.max(1, achievedPeakKW),
      note: "no policy can beat the floor; the gap is what better dispatch logic is worth here",
    },
    {
      name: "Engine energy dumped at minimum load",
      value: `${engineDumpMWh.toFixed(1)} MWh`,
      good: engineDumpMWh < 1,
      note: "a sizing problem, not a dispatch problem — no logic can turn an engine below its minimum",
    },
    {
      name: "Ceiling on price arbitrage value",
      value: `${(arbitrageCeilingEUR / 1000).toFixed(1)} k€/yr`,
      good: true,
      note: "the most any dispatch could earn from this battery on these prices — the prize for better logic",
    },
  ];

  return {
    findings,
    curtailedWithRoomMWh: curtailedWithRoomKWh / 1000,
    achievedPeakKW, achievablePeakKW, peakGapKW, peakGapEUR,
    arbitrageCeilingEUR, engineDumpMWh,
    clean: curtailedWithRoomKWh / 1000 < 0.1 && peakGapKW < 0.02 * Math.max(1, achievedPeakKW),
  };
}

/**
 * HOURLY RENEWABLE MATCHING — share of each hour's consumption backed by
 * renewable generation, for the Spanish draft royal decree on data centres
 * (80 % of every hour, from additional capacity). Pure function over the hourly
 * arrays the dispatch already returns: nothing in the dispatch itself changes.
 *
 * Two readings are reported because the draft does not settle the question:
 *   strict    — only generation produced in the same hour counts, so energy
 *               discharged from the battery does not.
 *   withStore — renewable energy stored earlier and discharged in this hour
 *               counts, which is the reading the industry has asked for.
 * Battery charging is attributed to renewable surplus first and to grid import
 * only for the remainder, and the stored renewable share is carried forward.
 */
function hourlyRenewableMatch(disp, inp, thresholdPct) {
  const thr = (thresholdPct === undefined ? 80 : thresholdPct) / 100;
  const b = inp.bess;
  const hasBess = b && b.enabled && b.energyKWh > 0;
  let hoursMetStrict = 0, hoursMetStore = 0, loadTotal = 0;
  let renewToLoadTotal = 0, storedRenewToLoadTotal = 0;
  let worstStrict = 1, worstStore = 1;
  // Renewable share of the energy currently held in the battery, 0..1
  let storeRenewFrac = 0, storeKWh = hasBess ? b.energyKWh * b.startSocPct / 100 : 0;

  for (let i = 0; i < H; i++) {
    const load = inp.load[i];
    const gen = (disp.pv[i] || 0) + (disp.wind[i] || 0);
    const chargeKWh = Math.max(0, -(disp.bess[i] || 0));
    const dischargeKWh = Math.max(0, disp.bess[i] || 0);

    // Renewable generation actually serving load this hour
    const spill = (disp.curtail[i] || 0) + (disp.exp[i] || 0);
    const renewDirect = Math.max(0, Math.min(load, gen - spill - chargeKWh));

    // Charging: renewable surplus first, grid for the remainder
    const surplusAfterLoad = Math.max(0, gen - spill - load);
    const chargeFromRenew = Math.min(chargeKWh, surplusAfterLoad);
    if (hasBess && chargeKWh > 0) {
      const newKWh = storeKWh + chargeKWh;
      storeRenewFrac = newKWh > 0 ? (storeRenewFrac * storeKWh + chargeFromRenew) / newKWh : 0;
      storeKWh = newKWh;
    }
    const renewFromStore = hasBess ? dischargeKWh * storeRenewFrac : 0;
    if (hasBess && dischargeKWh > 0) storeKWh = Math.max(0, storeKWh - dischargeKWh);

    const strict = load > 0 ? renewDirect / load : 1;
    const withStore = load > 0 ? Math.min(1, (renewDirect + renewFromStore) / load) : 1;
    if (strict >= thr - 1e-9) hoursMetStrict++;
    if (withStore >= thr - 1e-9) hoursMetStore++;
    if (strict < worstStrict) worstStrict = strict;
    if (withStore < worstStore) worstStore = withStore;
    loadTotal += load;
    renewToLoadTotal += renewDirect;
    // Capped at the hour's load: direct and stored renewable can both be
    // present in the same hour, and energy beyond the load is exported or
    // curtailed, not consumed, so it must not inflate the annual share.
    storedRenewToLoadTotal += Math.max(0, Math.min(load, renewDirect + renewFromStore) - renewDirect);
  }

  return {
    thresholdPct: thr * 100,
    hoursMetStrict, hoursMetStore, hours: H,
    pctHoursStrict: hoursMetStrict / H * 100,
    pctHoursStore: hoursMetStore / H * 100,
    annualPctStrict: loadTotal > 0 ? renewToLoadTotal / loadTotal * 100 : 0,
    annualPctStore: loadTotal > 0 ? (renewToLoadTotal + storedRenewToLoadTotal) / loadTotal * 100 : 0,
    worstHourPctStrict: worstStrict * 100,
    worstHourPctStore: worstStore * 100,
  };
}

/* ============================================================================
   DISPATCH CALIBRATION
   Three questions, answered with runs rather than opinions:
   1. What does the merit order leave on the table against the optimiser,
      on this design and this year?
   2. How much of the optimiser's edge survives a realistic forecast, given
      that its schedule is built before the day and the merit order reacts
      to what actually happens?
   3. Is the battery duty consistent with the warranty and the wear-cost
      assumption the optimiser steers by?
   ========================================================================== */

/** Deterministic 32-bit PRNG so the stress is reproducible. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw, clamped at ±CALIBRATION.ERROR_CLAMP_SIGMA. */
function gaussClamped(rng, clampSigma) {
  const u1 = Math.max(rng(), 1e-12), u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(-clampSigma, Math.min(clampSigma, z));
}

/**
 * A perturbed copy of the simulated year: the "outturn" against which a
 * schedule built on the expected year is executed. Day-level multiplicative
 * errors for PV, wind and load; day-level plus hour-level additive errors for
 * price, scaled to the mean absolute price so negative prices stay legitimate.
 */
function perturbYear(inp, C, seed) {
  const rng = mulberry32(seed);
  const days = Math.ceil(H / 24);
  const fPV = new Float32Array(days), fW = new Float32Array(days), fL = new Float32Array(days), dP = new Float32Array(days);
  for (let d = 0; d < days; d++) {
    fPV[d] = Math.max(0.05, 1 + C.PV_DAY_ERROR_PCT / 100 * gaussClamped(rng, C.ERROR_CLAMP_SIGMA));
    fW[d] = Math.max(0.05, 1 + C.WIND_DAY_ERROR_PCT / 100 * gaussClamped(rng, C.ERROR_CLAMP_SIGMA));
    fL[d] = Math.max(0.05, 1 + C.LOAD_DAY_ERROR_PCT / 100 * gaussClamped(rng, C.ERROR_CLAMP_SIGMA));
    dP[d] = gaussClamped(rng, C.ERROR_CLAMP_SIGMA);
  }
  let meanAbsP = 0;
  for (let i = 0; i < H; i++) meanAbsP += Math.abs(inp.price[i]);
  meanAbsP /= H;
  const pvGen = inp.pvGen ? new Float32Array(H) : null;
  const windGen = inp.windGen ? new Float32Array(H) : null;
  const load = new Float32Array(H), price = new Float32Array(H);
  for (let i = 0; i < H; i++) {
    const d = (i / 24) | 0;
    if (pvGen) pvGen[i] = inp.pvGen[i] * fPV[d];
    if (windGen) windGen[i] = inp.windGen[i] * fW[d];
    load[i] = Math.max(0, inp.load[i] * fL[d]);
    price[i] = inp.price[i] + meanAbsP * (C.PRICE_DAY_ERROR_PCT / 100 * dP[d]
      + C.PRICE_HOUR_ERROR_PCT / 100 * gaussClamped(rng, C.ERROR_CLAMP_SIGMA));
  }
  return { ...inp, pvGen, windGen, load, price };
}

/** Variable operating cost of a dispatch on a given price series — one basis for every comparison. */
function variableOperatingCost(d, price, inp, loc, costs) {
  let energy = 0;
  for (let i = 0; i < H; i++) energy += d.imp[i] * price[i] / 1000;
  const fuel = inp.engine.fuelType === "diesel"
    ? d.summary.fuelLitres * loc.diesel_EUR_per_litre
    : d.summary.fuelMWhTh * loc.gas_EUR_per_MWh_th;
  const demand = d.summary.meanMonthlyPeakKW * loc.capacityCharge_EUR_per_kW_yr;
  const exportRev = d.summary.exportMWh * (costs.EXPORT_PRICE_EUR_PER_MWH || 0);
  return { energy, fuel, demand, exportRev, total: energy + fuel + demand - exportRev,
    unservedMWh: d.summary.unservedMWh, cycles: d.summary.equivalentFullCycles,
    peakKW: d.summary.meanMonthlyPeakKW };
}

/** Discharge-depth statistics from the SOC trace: each contiguous discharge run counts once. */
function socCycleStats(soc) {
  const depths = [];
  let runStart = null;
  for (let i = 1; i < H; i++) {
    const falling = soc[i] < soc[i - 1] - 1e-6;
    if (falling && runStart === null) runStart = soc[i - 1];
    if (!falling && runStart !== null) {
      const depth = runStart - soc[i - 1];
      if (depth >= 1) depths.push(depth);
      runStart = null;
    }
  }
  if (runStart !== null) {
    const depth = runStart - soc[H - 1];
    if (depth >= 1) depths.push(depth);
  }
  if (!depths.length) return { meanDoDPct: 0, p95DoDPct: 0, segments: 0 };
  depths.sort((a, b) => a - b);
  const mean = depths.reduce((a, v) => a + v, 0) / depths.length;
  return { meanDoDPct: mean, p95DoDPct: depths[Math.min(depths.length - 1, Math.floor(0.95 * depths.length))], segments: depths.length };
}

/**
 * The calibration itself. `inp` must already carry the optimiser wear cost and
 * the fuel and export prices, exactly as the headline run does — the whole
 * point is that every number here is priced on the same basis as the tool's
 * own results. `headline` is the current headline dispatch (either mode).
 */
async function dispatchCalibration(a) {
  const { inp, loc, costs, headline, headlineOptimised, onPhase } = a;
  const CAL = CONSTANTS.CALIBRATION;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const canOptimise = inp.bess.enabled && inp.bess.energyKWh > 0;
  const out = { gap: { available: false }, forecast: { available: false }, battery: { available: false } };

  /* --- 1. Merit order against the optimum, expected year ------------------- */
  if (onPhase) onPhase("merit order against the optimum");
  await tick();
  const meritD = headlineOptimised ? dispatch(inp) : headline;
  if (!canOptimise) {
    out.gap = { available: false, reason: "No battery in the design — the merit order and the optimum coincide, there is nothing to calibrate." };
  } else {
    const optD = headlineOptimised ? headline : optimiseWithDemandCharge(inp, loc.capacityCharge_EUR_per_kW_yr);
    await tick();
    const cm = variableOperatingCost(meritD, inp.price, inp, loc, costs);
    const co = variableOperatingCost(optD, inp.price, inp, loc, costs);
    const diag = dispatchDiagnostics(meritD, inp, loc);
    const bound = operatingCostBound({ load: inp.load, pvGen: inp.pvGen, windGen: inp.windGen,
      price: inp.price, grid: inp.grid, engine: inp.engine, loc, costs });
    out.gap = {
      available: true, merit: cm, opt: co,
      gapEUR: cm.total - co.total,
      gapPct: cm.total > 0 ? (cm.total - co.total) / cm.total * 100 : 0,
      arbitrageCeilingEUR: diag.arbitrageCeilingEUR,
      peakGapEUR: diag.peakGapEUR,
      boundEUR: bound.boundEUR,
      optCeilingKW: optD.optimiserCeilingKW,
    };

    /* --- 2. Value of the forecast ---------------------------------------- */
    if (onPhase) onPhase("building the outturn year");
    await tick();
    const pert = perturbYear(inp, CAL, CAL.SEED);
    if (onPhase) onPhase("optimising with perfect knowledge of the outturn");
    await tick();
    const perfectD = optimiseWithDemandCharge(pert, loc.capacityCharge_EUR_per_kW_yr);
    if (onPhase) onPhase("executing the day-ahead schedule on the outturn");
    await tick();
    // The schedule built on the expected year, executed against the outturn:
    // the plant clips it to what is physically feasible hour by hour.
    const scheduledD = dispatch({ ...pert, forcedBattery: optD.bess });
    const meritOutD = dispatch(pert);
    const cp = variableOperatingCost(perfectD, pert.price, inp, loc, costs);
    const cs = variableOperatingCost(scheduledD, pert.price, inp, loc, costs);
    const cmo = variableOperatingCost(meritOutD, pert.price, inp, loc, costs);
    out.forecast = {
      available: true,
      sigma: { pv: CAL.PV_DAY_ERROR_PCT, wind: CAL.WIND_DAY_ERROR_PCT, load: CAL.LOAD_DAY_ERROR_PCT,
        priceDay: CAL.PRICE_DAY_ERROR_PCT, priceHour: CAL.PRICE_HOUR_ERROR_PCT, seed: CAL.SEED },
      perfect: cp, scheduled: cs, meritOut: cmo,
      forecastCostEUR: cs.total - cp.total,
      meritRegretEUR: cmo.total - cp.total,
      optimiserEdgeEUR: cmo.total - cs.total,
    };
  }

  /* --- 3. Battery duty against warranty and wear --------------------------- */
  if (inp.bess.enabled && inp.bess.energyKWh > 0 && headline.soc) {
    if (onPhase) onPhase("auditing the battery duty");
    await tick();
    const efc = headline.summary.equivalentFullCycles;
    const dischargeMWh = efc * inp.bess.energyKWh / 1000;
    const dod = socCycleStats(headline.soc);
    const budgetCyclesPerYr = CAL.WARRANTY_CYCLES / CAL.WARRANTY_YEARS;
    const yearsToExhaust = efc > 0.01 ? CAL.WARRANTY_CYCLES / efc : Infinity;
    const impliedWear = (costs.BESS_EUR_PER_KWH || 0) * 1000 / CAL.WARRANTY_CYCLES; // €/MWh of nameplate-cycle throughput
    const assumedWear = inp.bess.wearCostEURperMWh !== undefined ? inp.bess.wearCostEURperMWh : CONSTANTS.BESS_WEAR_COST_EUR_PER_MWH;
    const overBudget = efc > budgetCyclesPerYr;
    const underPriced = overBudget && assumedWear < impliedWear * CAL.WEAR_UNDERPRICE_FACTOR;
    const findings = [
      { name: "Cycle duty against the warranty budget",
        value: `${efc.toFixed(0)} EFC/yr against ${budgetCyclesPerYr.toFixed(0)} EFC/yr budgeted`,
        good: !overBudget,
        note: overBudget
          ? `at this duty the cycle allowance is exhausted in ${yearsToExhaust.toFixed(1)} yr, before the ${CAL.WARRANTY_YEARS}-yr term — plan an augmentation or slow the cycling`
          : `calendar life binds first (${CAL.WARRANTY_CYCLES} cycles over ${CAL.WARRANTY_YEARS} yr)` },
      { name: "Wear-cost assumption against full amortisation",
        value: `${assumedWear.toFixed(0)} €/MWh steering cost against ${impliedWear.toFixed(0)} €/MWh full replacement amortisation`,
        good: !underPriced,
        note: underPriced
          ? "the optimiser is cycling beyond the warranty budget while pricing wear far below replacement — raise the wear cost on the Microgrid tab"
          : "the steering cost is intentionally below full amortisation: capex already pays for the battery once, wear only has to deter worthless cycling" },
      { name: "Depth of discharge",
        value: `mean ${dod.meanDoDPct.toFixed(0)} %, P95 ${dod.p95DoDPct.toFixed(0)} % over ${dod.segments} discharge runs`,
        good: true,
        note: `operating window ${inp.bess.socMinPct}–${inp.bess.socMaxPct} % SOC` },
    ];
    out.battery = { available: true, efc, dischargeMWh, dod, budgetCyclesPerYr, yearsToExhaust,
      impliedWear, assumedWear, findings, clean: findings.every((f) => f.good) };
  } else {
    out.battery = { available: false, reason: "No battery in the design." };
  }

  return out;
}

/* ============================================================================
   WHAT TO CHANGE WHEN A CHECK FAILS
   Each failed check returns concrete, quantified moves rather than a verdict.
   ========================================================================== */
function remediation(adeq, a) {
  const { res, ctx, stats, char, aidcOut, mode } = a;
  const out = { energy: [], power: [], dynamic: [] };

  /* --- Energy --- */
  const en = adeq.energy;
  if (en.verdict !== "PASS") {
    if (en.unservedMWh > 0.01) {
      const gapKW = Math.max(0, stats.peakKW - (res.engine.enabled ? res.engine.units * res.engine.unitKW : 0)
        - (res.bess.enabled ? res.bess.powerKW : 0) - (ctx.gridStatus === "none" ? 0 : ctx.importCapKW));
      out.energy.push(`${en.unservedMWh.toFixed(1)} MWh/yr is not being served. Add about ${(Math.max(gapKW, stats.peakKW * 0.1) / 1000).toFixed(1)} MW of firm capacity — ${Math.max(1, Math.ceil(gapKW / Math.max(1, res.engine.unitKW)))} more engine unit(s), or raise the import cap.`);
    }
    if (en.autonomyFromBessH < en.autonomyRequiredH && !en.enginesCarryIsland) {
      const neededKWh = en.autonomyRequiredH * en.islandLoadKW;
      const window = ctx.islanding === "planned"
        ? (res.bess.socMaxPct - res.bess.socMinPct) / 100
        : Math.max(0.01, (res.bess.reserveSocPct - res.bess.socMinPct) / 100);
      const neededNameplate = neededKWh / window / Math.sqrt(res.bess.rtePct / 100);
      out.energy.push(`Autonomy is ${en.autonomyFromBessH.toFixed(1)} h against ${en.autonomyRequiredH} h required. Either grow the battery from ${(res.bess.energyKWh / 1000).toFixed(1)} to about ${(neededNameplate / 1000).toFixed(1)} MWh, or raise the reserve SOC from ${res.bess.reserveSocPct} % to about ${Math.min(95, Math.ceil(res.bess.socMinPct + neededKWh / Math.sqrt(res.bess.rtePct / 100) / res.bess.energyKWh * 100)) } %, or add engines that can carry the ${(en.islandLoadKW / 1000).toFixed(1)} MW island load (${Math.ceil(en.islandLoadKW / Math.max(1, res.engine.unitKW))} units of ${(res.engine.unitKW / 1000).toFixed(1)} MW).`);
      out.energy.push(`Or reduce what has to survive the island: dropping the critical share from ${char.critPct} % to ${Math.max(10, Math.round(char.critPct * en.autonomyFromBessH / en.autonomyRequiredH))} % would make the present battery sufficient.`);
    }
  }

  /* --- Power --- */
  const pw = adeq.power;
  if (pw.verdict !== "PASS") {
    if (pw.marginKW < 0) {
      const shortMW = -pw.marginKW / 1000;
      out.power.push(`After losing ${pw.largestUnit ? pw.largestUnit.name : "the largest unit"} the system is ${shortMW.toFixed(2)} MW short. Add ${Math.ceil(-pw.marginKW / Math.max(1, res.engine.unitKW))} engine unit(s) of ${(res.engine.unitKW / 1000).toFixed(1)} MW, or raise the import cap by ${shortMW.toFixed(2)} MW.`);
      out.power.push(`Smaller units also help without adding capacity: with N-1 sized on the largest unit, ${Math.ceil((pw.coincidentPeakKW) / Math.max(1, res.engine.unitKW / 2))} units of ${(res.engine.unitKW / 2000).toFixed(1)} MW would leave a smaller hole when one is lost.`);
    }
    if (pw.losesGridForming) {
      out.power.push(`Losing ${pw.largestUnit ? pw.largestUnit.name : "the largest unit"} also removes the grid-forming source, so the island cannot be held at all. Split the battery into two smaller grid-forming units, or add grid-forming capability to a second asset.`);
    }
  }

  /* --- Dynamic --- */
  const dy = adeq.dynamic;
  if (dy.verdict !== "PASS") {
    const deficitKW = dy.deficitMW * 1000;
    if (deficitKW > 0) {
      const bessNeeded = res.bess.gridFormingStepPct > 0 ? deficitKW / (res.bess.gridFormingStepPct / 100) : 0;
      out.dynamic.push(`The ${(dy.worstStepKW / 1000).toFixed(2)} MW step exceeds fast response by ${dy.deficitMW.toFixed(2)} MW. Add about ${(bessNeeded / 1000).toFixed(1)} MW of grid-forming battery power (now ${(res.bess.powerKW / 1000).toFixed(1)} MW), or keep ${Math.ceil(deficitKW / Math.max(1, res.engine.unitKW * res.engine.stepAcceptancePct / 100))} more engine unit(s) online.`);
      if (!res.bess.gridForming && res.bess.enabled) {
        out.dynamic.push(`The battery is set to grid-following, so none of its ${(res.bess.powerKW / 1000).toFixed(1)} MW counts towards the step. Switching it to grid-forming would add ${(res.bess.powerKW * res.bess.gridFormingStepPct / 100 / 1000).toFixed(1)} MW of instantaneous response — usually the cheapest fix on this page.`);
      }
      if (mode === "aidc") {
        out.dynamic.push(`Or reduce the step itself: the ${(dy.loadStepKW / 1000).toFixed(2)} MW comes from a ${a.aidc ? a.aidc.loadSwingPct : ""} % collective compute swing. Job-start staggering or a ramp-rate limit in the scheduler is a software change, not a capital one.`);
      }
      if (dy.inertiaMWs < 5) {
        out.dynamic.push(`System inertia is only ${dy.inertiaMWs.toFixed(1)} MW·s, so frequency moves fast for any imbalance. Running one more rotating unit, or specifying synthetic inertia on the battery, buys time for the governors.`);
      }
    }
  }

  return out;
}

/* ============================================================================
   PHASE 4 ENGINE — costs and LCOE
   ========================================================================== */

/** CSV templates, generated in the browser so the expected format is never in doubt. */
function buildLoadTemplateCSV(cal) {
  const lines = ["timestamp,load_kW"];
  for (let i = 0; i < H; i++) {
    const m = String(cal.month[i] + 1).padStart(2, "0");
    let d = cal.doy[i], mm = 0;
    while (d >= CONSTANTS.DAYS_PER_MONTH[mm]) { d -= CONSTANTS.DAYS_PER_MONTH[mm]; mm++; }
    lines.push(`${CONSTANTS.REFERENCE_YEAR}-${m}-${String(d + 1).padStart(2, "0")} ${String(cal.hourOfDay[i]).padStart(2, "0")}:00,`);
  }
  return lines.join("\n");
}

function buildResourceTemplateCSV(cal) {
  const lines = ["timestamp,ghi_W_m2,temp_C"];
  for (let i = 0; i < H; i++) {
    const m = String(cal.month[i] + 1).padStart(2, "0");
    let d = cal.doy[i], mm = 0;
    while (d >= CONSTANTS.DAYS_PER_MONTH[mm]) { d -= CONSTANTS.DAYS_PER_MONTH[mm]; mm++; }
    lines.push(`${CONSTANTS.REFERENCE_YEAR}-${m}-${String(d + 1).padStart(2, "0")} ${String(cal.hourOfDay[i]).padStart(2, "0")}:00,,`);
  }
  return lines.join("\n");
}

function buildPriceTemplateCSV(cal) {
  const lines = ["timestamp,price_EUR_per_MWh"];
  for (let i = 0; i < H; i++) {
    const m = String(cal.month[i] + 1).padStart(2, "0");
    let d = cal.doy[i], mm = 0;
    while (d >= CONSTANTS.DAYS_PER_MONTH[mm]) { d -= CONSTANTS.DAYS_PER_MONTH[mm]; mm++; }
    lines.push(`${CONSTANTS.REFERENCE_YEAR}-${m}-${String(d + 1).padStart(2, "0")} ${String(cal.hourOfDay[i]).padStart(2, "0")}:00,`);
  }
  return lines.join("\n");
}

function downloadCSV(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

/**
 * COSTS AND LCOE
 *
 *            CAPEX₀ + Σₜ (OPEX_t + fuel_t + import_t + augmentation_t − export_t) / (1+r)ᵗ
 *   LCOE =  ───────────────────────────────────────────────────────────────────────────────
 *                              Σₜ  E_t / (1+r)ᵗ
 *
 * The hourly dispatch is run once and projected across the project life with
 * PV degradation applied. Energy lost to degradation is re-assigned to the
 * marginal source — grid import where a connection exists, otherwise engine
 * fuel — rather than re-running 8760 hours for every year. That is a
 * pre-feasibility simplification and it is stated on the screen.
 */
function computeCosts(a) {
  const { res, ctx, loc, disp, price, costs, itEnergyMWh, gridEnabled, firmCapKW } = a;
  const s = disp.summary;
  const r = ctx.discountPct / 100;
  const N = ctx.lifeYears;

  /* --- CAPEX --------------------------------------------------------------- */
  const pvMWp = res.pv.enabled ? res.pv.kWp / 1000 : 0;
  const windMW = res.wind.enabled ? res.wind.ratedKW / 1000 : 0;
  const bessMW = res.bess.enabled ? res.bess.powerKW / 1000 : 0;
  const bessMWh = res.bess.enabled ? res.bess.energyKWh / 1000 : 0;
  const engMW = res.engine.enabled ? res.engine.units * res.engine.unitKW / 1000 : 0;
  const turbMW = res.turbine.enabled ? res.turbine.ratedKW / 1000 : 0;

  const capexPV = pvMWp * 1000 * costs.PV_EUR_PER_KWP;
  const capexWind = windMW * 1000 * costs.WIND_EUR_PER_KW;
  const capexBESS = bessMW * 1000 * (costs.BESS_EUR_PER_KW + (res.bess.gridForming ? costs.BESS_GRID_FORMING_ADDER_EUR_PER_KW : 0))
    + bessMWh * 1000 * costs.BESS_EUR_PER_KWH;
  const capexEngine = engMW * 1000 * (res.engine.fuelType === "gas" ? costs.ENGINE_GAS_EUR_PER_KW : costs.ENGINE_DIESEL_EUR_PER_KW);
  const capexTurbine = turbMW * 1000 * costs.TURBINE_EUR_PER_KW;
  const capexGrid = gridEnabled ? firmCapKW * costs.GRID_CONNECTION_EUR_PER_KW : 0;

  // Balance of plant as a function of quantities, not a flat percentage.
  const capexBOP = pvMWp * costs.BOP_EUR_PER_MWP_PV
    + bessMW * costs.BOP_EUR_PER_MW_BESS + bessMWh * costs.BOP_EUR_PER_MWH_BESS
    + (engMW + turbMW) * costs.BOP_EUR_PER_MW_THERMAL
    + (pvMWp + windMW + bessMW + engMW + turbMW) * costs.BOP_EUR_PER_MW_SWITCHGEAR
    + (pvMWp + windMW + bessMW + engMW + turbMW > 0 ? costs.BOP_FIXED_EUR : 0);

  const capexTotal = capexPV + capexWind + capexBESS + capexEngine + capexTurbine + capexGrid + capexBOP;

  /* --- Year-one operating cost --------------------------------------------- */
  let importCostY1 = 0;
  if (gridEnabled) for (let i = 0; i < H; i++) importCostY1 += disp.imp[i] * price[i] / 1000;
  const exportRevenueY1 = s.exportMWh * costs.EXPORT_PRICE_EUR_PER_MWH;
  // Billed on each month's peak (the mean of the twelve equals the annual bill
  // when the rate is quoted per kW-month), not on the single annual maximum.
  const billedPeakKW = s.meanMonthlyPeakKW !== undefined ? s.meanMonthlyPeakKW : s.peakImportKW;
  const capacityChargeY1 = gridEnabled ? (billedPeakKW * loc.capacityCharge_EUR_per_kW_yr) : 0;
  const fuelCostY1 = res.engine.fuelType === "diesel"
    ? s.fuelLitres * loc.diesel_EUR_per_litre
    : s.fuelMWhTh * loc.gas_EUR_per_MWh_th;
  const omPV = pvMWp * 1000 * costs.OM_PV_EUR_PER_KWP_YR;
  const omWind = windMW * 1000 * costs.OM_WIND_EUR_PER_KW_YR;
  const omBESS = capexBESS * costs.OM_BESS_PCT_CAPEX_YR / 100;
  const omEngine = (engMW + turbMW) * s.engineHours * costs.OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW;

  /* --- Marginal cost of replacing a lost renewable MWh --------------------- */
  const meanImportPrice = gridEnabled ? (importCostY1 > 0 && s.importMWh > 0 ? importCostY1 / s.importMWh
    : loc.importTariff_EUR_per_MWh + loc.gridFee_EUR_per_MWh) : 0;
  // Marginal engine cost is taken at 75 % load, straight off the same part-load
  // curve the dispatch uses — no second, implicit efficiency figure.
  const engineMarginal = res.engine.fuelType === "diesel"
    ? 1000 * partLoadValue(CONSTANTS.DIESEL_SFC_L_PER_KWH, 75) * loc.diesel_EUR_per_litre
    : loc.gas_EUR_per_MWh_th / (partLoadValue(CONSTANTS.GAS_ENGINE_EFF_PCT, 75) / 100);
  const marginalEUR_per_MWh = gridEnabled ? meanImportPrice : engineMarginal;

  /* --- Energy served at the chosen boundary -------------------------------- */
  const servedMWh = s.loadMWh - s.unservedMWh - s.shed1MWh - s.shed2MWh;

  /* --- Discounted streams --------------------------------------------------- */
  const years = [];
  let npvCost = capexTotal, npvEnergyFacility = 0, npvEnergyIT = 0;
  const augYears = String(costs.AUGMENTATION_YEARS || "").split(",").map((v) => parseInt(v, 10)).filter((v) => v > 0);
  let discOM = 0, discFuel = 0, discImport = 0, discAug = 0, discCapacity = 0, discExport = 0;

  for (let t = 1; t <= N; t++) {
    const df = 1 / Math.pow(1 + r, t);
    const degFactor = Math.max(0, 1 - res.pv.degradationPctPerYr / 100 * (t - 1));
    const lostPVMWh = res.pv.enabled ? s.pvMWh * (1 - degFactor) : 0;
    const replacementCost = lostPVMWh * marginalEUR_per_MWh;

    const fuelT = fuelCostY1 + (gridEnabled ? 0 : replacementCost);
    const importT = importCostY1 + (gridEnabled ? replacementCost : 0);
    const omT = omPV + omWind + omBESS + omEngine;
    const capT = capacityChargeY1;
    const expT = exportRevenueY1 * degFactor;

    // Battery augmentation: restore the faded capacity in the nominated years
    let augT = 0;
    if (augYears.includes(t) && res.bess.enabled) {
      const fade = Math.min(0.4, CONSTANTS.BESS_CALENDAR_FADE_PCT_PER_YR / 100 * t
        + CONSTANTS.BESS_CYCLE_FADE_PCT_PER_EFC / 100 * s.equivalentFullCycles * t);
      augT = res.bess.energyKWh * fade * costs.BESS_AUGMENTATION_EUR_PER_KWH;
    }

    const yearCost = omT + fuelT + importT + capT + augT - expT;
    npvCost += yearCost * df;
    npvEnergyFacility += servedMWh * df;
    npvEnergyIT += itEnergyMWh * df;

    discOM += omT * df; discFuel += fuelT * df; discImport += importT * df;
    discAug += augT * df; discCapacity += capT * df; discExport += expT * df;

    years.push({ year: t, df, om: omT, fuel: fuelT, import: importT, capacity: capT, aug: augT, export: expT, total: yearCost });
  }

  const lcoeFacility = npvEnergyFacility > 0 ? npvCost / npvEnergyFacility : 0;
  const lcoeIT = npvEnergyIT > 0 ? npvCost / npvEnergyIT : 0;

  /* --- Contribution by component, €/MWh at the facility busbar --------------- */
  const perMWh = (v) => (npvEnergyFacility > 0 ? v / npvEnergyFacility : 0);
  const breakdown = [
    { name: "PV", capex: capexPV, lcoe: 0 },
    { name: "Wind", capex: capexWind, lcoe: 0 },
    { name: "BESS", capex: capexBESS, lcoe: 0 },
    { name: "Engines", capex: capexEngine, lcoe: 0 },
    { name: "Turbine", capex: capexTurbine, lcoe: 0 },
    { name: "Grid connection", capex: capexGrid, lcoe: 0 },
    { name: "Balance of plant", capex: capexBOP, lcoe: 0 },
  ].filter((x) => x.capex > 0).map((x) => ({ ...x, lcoe: perMWh(x.capex) }));

  const opexBreakdown = [
    { name: "O&M", value: discOM },
    { name: "Fuel", value: discFuel },
    { name: "Grid energy", value: discImport },
    { name: "Grid capacity", value: discCapacity },
    { name: "Augmentation", value: discAug },
    { name: "Export revenue", value: -discExport },
  ].filter((x) => Math.abs(x.value) > 1).map((x) => ({ ...x, lcoe: perMWh(x.value) }));

  return {
    capex: { pv: capexPV, wind: capexWind, bess: capexBESS, engine: capexEngine, turbine: capexTurbine, grid: capexGrid, bop: capexBOP, total: capexTotal },
    y1: { importCost: importCostY1, exportRevenue: exportRevenueY1, capacityCharge: capacityChargeY1, fuel: fuelCostY1, omPV, omWind, omBESS, omEngine },
    npvCost, npvEnergyFacility, npvEnergyIT, servedMWh, itEnergyMWh,
    lcoeFacility, lcoeIT, breakdown, opexBreakdown, years,
    marginalEUR_per_MWh, discounted: { om: discOM, fuel: discFuel, import: discImport, capacity: discCapacity, aug: discAug, export: discExport },
  };
}

/**
 * First-order sensitivity. Yield is varied by scaling renewable energy and
 * re-pricing the difference at the marginal source — the same approximation
 * used for degradation, and for the same reason.
 */
function lcoeSensitivity(a, base) {
  const { res, ctx, disp, costs } = a;
  const s = disp.summary;

  const shift = (opts) => {
    const r = (ctx.discountPct + (opts.discountDelta || 0)) / 100;
    const N = ctx.lifeYears;
    const capex = base.capex.total * (opts.capexMult || 1);
    const deltaRenewMWh = s.pvMWh * ((opts.yieldMult || 1) - 1);
    let npv = capex, npvE = 0;
    for (let t = 1; t <= N; t++) {
      const df = 1 / Math.pow(1 + r, t);
      const y = base.years[t - 1];
      const cost = y.om + (y.fuel * (opts.fuelMult || 1)) + y.import + y.capacity + y.aug - y.export
        - deltaRenewMWh * base.marginalEUR_per_MWh;
      npv += cost * df;
      npvE += base.servedMWh * df;
    }
    return npvE > 0 ? npv / npvE : 0;
  };

  const pts = [];
  for (const d of [-20, -10, 0, 10, 20]) {
    pts.push({
      delta: d,
      yield: +shift({ yieldMult: 1 + d / 100 }).toFixed(1),
      capex: +shift({ capexMult: 1 + d / 100 }).toFixed(1),
      fuel: +shift({ fuelMult: 1 + d / 100 }).toFixed(1),
      discount: +shift({ discountDelta: d / 10 }).toFixed(1),
    });
  }
  return pts;
}

/* ============================================================================
   PHASE 5 / 6 ENGINE — counterfactual, financials, auto-size, export
   ========================================================================== */

/**
 * COUNTERFACTUAL. A microgrid has no revenue of its own; its cashflow is the
 * cost it avoids. The baseline is the same load served the obvious way:
 * entirely from the grid where a connection exists, otherwise entirely from
 * engines. Stated explicitly, because every NPV below depends on it.
 */
function computeBaseline(a) {
  const { load, price, loc, gridEnabled, res, costs, cal } = a;
  let energyMWh = 0, peakKW = 0, gridCost = 0;
  const monthlyPeak = new Array(12).fill(0);
  for (let i = 0; i < H; i++) {
    energyMWh += load[i] / 1000;
    if (load[i] > peakKW) peakKW = load[i];
    if (load[i] > monthlyPeak[cal.month[i]]) monthlyPeak[cal.month[i]] = load[i];
    gridCost += load[i] * price[i] / 1000;
  }
  // Same billing basis as the project case — monthly peaks, not the annual one
  const billedPeakKW = monthlyPeak.reduce((a, v) => a + v, 0) / 12;
  if (gridEnabled) {
    return {
      mode: "grid", energyMWh, peakKW, billedPeakKW,
      annualCost: gridCost + billedPeakKW * loc.capacityCharge_EUR_per_kW_yr,
      capex: peakKW * costs.GRID_CONNECTION_EUR_PER_KW,
      label: "all load imported from the grid at the site tariff",
    };
  }
  // Engines only: sized for the peak with one spare, run at ~75 % load
  const unitKW = res.engine.unitKW || 2500;
  const units = Math.ceil(peakKW / unitKW) + 1;
  const sfc = partLoadValue(CONSTANTS.DIESEL_SFC_L_PER_KWH, 75);
  const fuelCost = res.engine.fuelType === "diesel"
    ? energyMWh * 1000 * sfc * loc.diesel_EUR_per_litre
    : energyMWh / (partLoadValue(CONSTANTS.GAS_ENGINE_EFF_PCT, 75) / 100) * loc.gas_EUR_per_MWh_th;
  const om = units * unitKW / 1000 * H * costs.OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW;
  return {
    mode: "engine", energyMWh, peakKW, annualCost: fuelCost + om,
    capex: units * unitKW * (res.engine.fuelType === "gas" ? costs.ENGINE_GAS_EUR_PER_KW : costs.ENGINE_DIESEL_EUR_PER_KW),
    label: `${units} × ${(unitKW / 1000).toFixed(1)} MW engines running continuously`,
  };
}

/** IRR by bisection on the discount rate. Returns null when no sign change exists. */
function irr(cashflows) {
  const npvAt = (r) => cashflows.reduce((t, cf, i) => t + cf / Math.pow(1 + r, i), 0);
  if (npvAt(0) <= 0) return null;
  let lo = 0, hi = 1;
  for (let k = 0; k < 100 && npvAt(hi) > 0; k++) hi *= 1.5;
  if (npvAt(hi) > 0) return null;
  for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (npvAt(m) > 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/**
 * FINANCIAL MODEL — optional. Cashflow is the avoided cost of the baseline,
 * less the project's own operating cost. Debt, when entered, is a level
 * annuity and DSCR is cash available for debt service over that annuity.
 */
function computeFinancials(a) {
  const { cost, baseline, ctx, fin } = a;
  const N = ctx.lifeYears, r = ctx.discountPct / 100;
  const capex = cost.capex.total - (fin.creditBaselineCapex ? baseline.capex : 0);
  const debt = capex * fin.gearingPct / 100;
  const equity = capex - debt;
  const i = fin.interestPct / 100;
  const debtService = debt > 0 && fin.tenorYears > 0 && i > 0
    ? debt * i / (1 - Math.pow(1 + i, -fin.tenorYears))
    : debt > 0 && fin.tenorYears > 0 ? debt / fin.tenorYears : 0;

  const rows = [];
  const projectCF = [-capex], equityCF = [-equity];
  let cumulative = -capex, payback = null, minDSCR = Infinity;
  for (let t = 1; t <= N; t++) {
    const y = cost.years[t - 1];
    const projectOpex = y.om + y.fuel + y.import + y.capacity + y.aug - y.export;
    const saving = baseline.annualCost - projectOpex;
    const ds = t <= fin.tenorYears ? debtService : 0;
    const dscr = ds > 0 ? saving / ds : null;
    if (dscr !== null && dscr < minDSCR) minDSCR = dscr;
    cumulative += saving;
    if (payback === null && cumulative >= 0) payback = t - 1 + (saving > 0 ? (saving - cumulative) / saving : 0);
    projectCF.push(saving);
    equityCF.push(saving - ds);
    rows.push({ year: t, baselineCost: baseline.annualCost, projectOpex, saving, debtService: ds, dscr, cumulative });
  }
  const npv = projectCF.reduce((t2, cf, k) => t2 + cf / Math.pow(1 + r, k), 0);
  return {
    capex, debt, equity, debtService, rows,
    npv, irr: irr(projectCF), equityIrr: irr(equityCF),
    paybackYears: payback, minDSCR: minDSCR === Infinity ? null : minDSCR,
    annualSavingY1: rows.length ? rows[0].saving : 0,
  };
}

/**
 * AUTO-SIZE — a bounded sweep, not an optimiser. Every combination is run
 * through the same dispatch and the same adequacy checks; anything that fails
 * a check is discarded, and the survivors are ranked by LCOE. The output is a
 * ranked set with the trade-off visible, never a single "answer".
 */
async function autoSize(a) {
  const { base, bounds, evaluate, onProgress, tick } = a;
  const combos = [];
  const winds = bounds.windKW && bounds.windKW.length ? bounds.windKW : [0];
  for (const kWp of bounds.pvKWp)
    for (const windKW of winds)
      for (const bMW of bounds.bessMW)
        for (const hrs of bounds.bessHours)
          for (const units of bounds.engineUnits)
            combos.push({ kWp, windKW, bessKW: bMW * 1000, bessKWh: bMW * 1000 * hrs, units, hours: hrs });

  /* Evaluated in small batches with a yield between them. Without the yield the
     whole sweep ran inside one synchronous call and nothing on screen could
     repaint, so the progress indicator never appeared however long it took. */
  const results = [];
  for (let idx = 0; idx < combos.length; idx++) {
    results.push({ ...combos[idx], ...evaluate(combos[idx]) });
    if (idx % 4 === 3 || idx === combos.length - 1) {
      if (onProgress) onProgress((idx + 1) / combos.length);
      if (tick) await tick();
    }
  }
  const feasible = results.filter((r) => r.feasible).sort((x, y) => x.lcoe - y.lcoe);
  return { all: results, feasible, tried: combos.length, best: feasible[0] || null };
}

/* --- Guided auto-size ------------------------------------------------------ */

/** Quantile of an array without mutating it. q in 0…1; q of the value exceeded (1-q) of the time. */
function quantile(arr, q) {
  const s = Array.from(arr).sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[idx];
}

/**
 * SEARCH-SPACE PROPOSAL — derives the ranges the guided search will test from
 * what the tool already knows: the load, the connection, the resource, the land
 * and the tariff structure. Every bound is an explicit, named anchor so the
 * question "why was this size tested" always has an answer. Pure function:
 * everything it needs arrives as an argument, nothing is read from state.
 */
function proposeSearchSpace(a) {
  const { load, stats, pvUnit, windAnnualMWhPerMW, windMean, gridEnabled, importCapKW,
    parasiticKW, islanded, islandLoadKW, landCapKWp, bessCapMW, engineCapMW,
    engineUnitKW, mode, windCapexEURperKW, windOMEURperKWyr, deliveredGridEURperMWh,
    discountPct, lifeYears, exportCapKW, dcacRatio,
    engineEconomicRun, engineMarginalEURperMWh, engineFuelType } = a;
  const AZ = CONSTANTS.AUTOSIZE;
  const round100 = (v) => Math.round(v / 100) * 100;

  /* PV — two constraints govern the axis. Annual energy sets the load-match
     size; what the busbar can absorb (peak load + export capacity, in DC terms)
     sets the scale the coarse pass actually tests, because behind a tight
     export cap the surplus has nowhere to go and load-match over-states the
     useful size by a wide margin. Land and the over-build limit stay as the
     hard bound, so refinement can still climb where the economics justify it. */
  let pvUnitAnnual = 0;
  for (let i = 0; i < H; i++) pvUnitAnnual += pvUnit[i]; // kWh per kWp per year, pre plant losses
  const dcac = dcacRatio > 0 ? dcacRatio : 1.2;
  const loadMatchKWp = stats.annualMWh * 1000 / Math.max(1, pvUnitAnnual);
  let pvMaxKWp = loadMatchKWp * AZ.PV_OVERBUILD_MAX;
  let pvBoundBy = `${AZ.PV_OVERBUILD_MAX} × load-match (over-build limit)`;
  if (landCapKWp > 0 && landCapKWp < pvMaxKWp) { pvMaxKWp = landCapKWp; pvBoundBy = "land available"; }

  /* Axis scale — what the busbar can absorb. The storage allowance in the
     absorption term is the fixed fallback fraction of peak, NOT the surplus
     anchor computed below: the surplus anchor depends on the PV size and the
     PV scale would depend on it in turn, and that circularity mis-scales
     every axis in whichever direction it is resolved. */
  const bessScaleKW = round100(stats.peakKW * AZ.BESS_FALLBACK_PEAK_FRACTION);
  const absorbKWp = round100((stats.peakKW + parasiticKW + (exportCapKW || 0) + bessScaleKW) * dcac);
  const pvScaleKWp = Math.min(loadMatchKWp, absorbKWp, pvMaxKWp);

  /* PV surplus profile at the largest PV size the coarse pass tests — the
     storage power anchor. "A battery sized to absorb the surplus of the
     largest PV on the table" is a statement an analyst can defend. */
  const refKWp = Math.min(round100(pvScaleKWp * Math.max(...AZ.PV_COARSE_LEVELS)), pvMaxKWp);
  const surplus = new Float32Array(H);
  const dailySurplus = new Float64Array(365);
  for (let i = 0; i < H; i++) {
    surplus[i] = Math.max(0, pvUnit[i] * refKWp - load[i]);
    dailySurplus[Math.min(364, Math.floor(i / 24))] += surplus[i] / 1000;
  }
  const surplusKW = round100(quantile(surplus, AZ.SURPLUS_POWER_QUANTILE));
  const medianDailySurplusMWh = quantile(dailySurplus, 0.5);

  /* Storage — three anchors: cover the connection shortfall, shave the peak, absorb the surplus */
  const deficitKW = round100(Math.max(0, stats.peakKW + parasiticKW - (gridEnabled ? importCapKW : 0)));
  const shaveKW = round100(Math.max(0, stats.peakKW - quantile(load, AZ.SHAVE_QUANTILE)));
  const fallbackKW = round100(stats.peakKW * AZ.BESS_FALLBACK_PEAK_FRACTION);
  let anchors = [deficitKW, shaveKW, surplusKW].filter((v) => v > 0);
  if (!anchors.length) anchors = [fallbackKW];
  const bessHardCapKW = bessCapMW > 0 ? bessCapMW * 1000 : Infinity;
  const bessMaxKW = Math.min(Math.max(...anchors), bessHardCapKW);
  let bessLevelsKW = [...new Set(anchors.map((v) => Math.min(v, bessHardCapKW)))].sort((x, y) => x - y);
  if (bessLevelsKW.length > 3) bessLevelsKW = [bessLevelsKW[0], bessLevelsKW[Math.floor(bessLevelsKW.length / 2)], bessLevelsKW[bessLevelsKW.length - 1]];
  bessLevelsKW = [0, ...bessLevelsKW.filter((v) => v > 0)];

  const pvLevelsKWp = [...new Set(AZ.PV_COARSE_LEVELS.map((f) => round100(Math.min(f * pvScaleKWp, pvMaxKWp))))];

  /* Wind — screened on its standalone LCOE against the delivered grid price,
     using this site's simulated capacity factor and the project's own cost and
     discount assumptions. A m/s threshold would hide the economics. */
  const windLoadMatchKW = windAnnualMWhPerMW > 0 ? round100(stats.annualMWh / windAnnualMWhPerMW * 1000) : 0;
  // Same absorption logic as PV: rated capacity beyond what the busbar can take at full output only curtails
  const windScaleKW = Math.min(windLoadMatchKW, round100(stats.peakKW + parasiticKW + (exportCapKW || 0) + bessScaleKW));
  const r = Math.max(0.0001, (discountPct || 6) / 100);
  const n = Math.max(1, lifeYears || 25);
  const crf = r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  const windLCOE = windAnnualMWhPerMW > 0
    ? ((windCapexEURperKW || 0) * crf + (windOMEURperKWyr || 0)) / (windAnnualMWhPerMW / 1000)
    : Infinity; // €/MWh, standalone, before integration effects
  const windScreenPass = windLCOE < (deliveredGridEURperMWh || 0) * AZ.WIND_SCREEN_MARGIN;
  const windDefaultInclude = windScreenPass && mode !== "aidc" && windLoadMatchKW > 0;
  const windReason = mode === "aidc"
    ? "excluded by default in AIDC mode — no land model for turbines on a data-centre site"
    : `standalone wind LCOE ${isFinite(windLCOE) ? windLCOE.toFixed(0) : "—"} €/MWh (${(windAnnualMWhPerMW / 87.6).toFixed(0)} % capacity factor at ${windMean.toFixed(1)} m/s) against a delivered grid price of ${(deliveredGridEURperMWh || 0).toFixed(0)} €/MWh — ${windScreenPass ? "worth testing" : "excluded by default"}`;
  const windLevelsKW = [...new Set(AZ.WIND_COARSE_LEVELS.map((f) => round100(f * windScaleKW)))];

  /* Engines — only where a firm shortfall exists: connection gap or an islanding duty */
  const engineGapKW = deficitKW > 0 ? deficitKW : (islanded ? round100(islandLoadKW) : 0);
  const engineDefaultInclude = engineGapKW > 0 || !!a.engineEconomicRun;
  const engineHardCapUnits = engineCapMW > 0 ? Math.floor(engineCapMW * 1000 / Math.max(1, engineUnitKW)) : Infinity;
  const needUnits = engineGapKW > 0 ? Math.ceil(engineGapKW / Math.max(1, engineUnitKW)) : 0;
  // Where an islanding duty exists, the power adequacy check (including N-1) is
  // what sets the count, not the energy gap — so that duty is anchored as well.
  const islandUnits = islanded && islandLoadKW > 0 ? Math.ceil(islandLoadKW / Math.max(1, engineUnitKW)) : 0;
  /* Where a firm shortfall exists the count is anchored on it. Where none does,
     the axis used to collapse to [0], so asking for generation to be searched
     tested exactly one design: none of it. Fleet sizes are now proposed as
     fractions of the site peak instead, so the question can be answered. */
  const unitsForPeak = Math.ceil((stats.peakKW + parasiticKW) / Math.max(1, engineUnitKW));
  const engineMaxUnits = Math.min(engineHardCapUnits, Math.ceil(unitsForPeak * AZ.ENGINE_MAX_HEADROOM));
  let engineLevels = engineGapKW > 0
    ? [...new Set([0, needUnits, needUnits + 1, islandUnits, islandUnits + 1].filter((u) => u >= 0))]
    : [0, ...AZ.ENGINE_PEAK_FRACTIONS.map((f) => Math.ceil(f * unitsForPeak))];
  engineLevels = [...new Set(engineLevels)]
    .filter((u) => u >= 0 && u <= engineMaxUnits)
    .sort((x, y) => x - y);
  /* Economics, not only adequacy: with economic running switched on the fleet
     is worth testing wherever its marginal cost sits below the delivered grid
     price, whether or not anything obliges the site to install it. */
  const engineMarginal = engineMarginalEURperMWh || 0;
  const engineUndercutsGrid = engineMarginal > 0 && engineMarginal < (deliveredGridEURperMWh || 0);
  const engineEconomicCase = !!engineEconomicRun && engineUndercutsGrid;
  const engineReason = deficitKW > 0
    ? `the connection is ${(deficitKW / 1000).toFixed(1)} MW short of the peak — firm generation must bridge it`
    : islanded ? `an islanding duty of ${(islandLoadKW / 1000).toFixed(1)} MW needs firm generation behind it`
    : engineEconomicCase
      ? `no firm shortfall, but at ${engineMarginal.toFixed(0)} €/MWh the fleet undercuts the delivered grid price of ${(deliveredGridEURperMWh || 0).toFixed(0)} €/MWh — worth testing on economics`
      : engineUndercutsGrid
        ? `no firm shortfall. The fleet would run at ${engineMarginal.toFixed(0)} €/MWh against a delivered grid price of ${(deliveredGridEURperMWh || 0).toFixed(0)} €/MWh, but economic running is switched off, so a generator can only add capital cost here`
        : `no firm shortfall, and at ${engineMarginal.toFixed(0)} €/MWh the fleet does not undercut the delivered grid price of ${(deliveredGridEURperMWh || 0).toFixed(0)} €/MWh`;

  return {
    pv: { include: true, loadMatchKWp: round100(loadMatchKWp), scaleKWp: pvScaleKWp, absorptionKWp: absorbKWp,
      maxKWp: round100(pvMaxKWp), boundBy: pvBoundBy, levelsKWp: pvLevelsKWp },
    wind: { include: windDefaultInclude, loadMatchKW: windLoadMatchKW, scaleKW: windScaleKW, maxKW: windLoadMatchKW,
      levelsKW: windLevelsKW, reason: windReason, standaloneLCOE: windLCOE },
    bess: { include: true, anchors: { deficitKW, shaveKW, surplusKW, fallbackKW }, maxKW: round100(bessMaxKW),
      hardCapKW: bessHardCapKW, levelsKW: bessLevelsKW, durationsH: AZ.BESS_DURATIONS_H.slice(), medianDailySurplusMWh },
    engine: { include: engineDefaultInclude, unitKW: engineUnitKW, gapKW: engineGapKW, needUnits, levels: engineLevels,
      maxUnits: engineMaxUnits, reason: engineReason,
      marginalEURperMWh: engineMarginal, economicRun: !!engineEconomicRun,
      fuelType: engineFuelType || "gas", undercutsGrid: engineUndercutsGrid },
  };
}

/**
 * GUIDED AUTO-SIZE — a coarse pass over anchor-derived sizes, then coordinate
 * refinement around the leading design, then (when the headline method is the
 * optimiser) re-pricing of a short list under optimisation. Screening always
 * runs in the merit order so a wide search stays interactive; the shortlist
 * carries both numbers so the screening error is visible, never hidden.
 * Every candidate records why it was tested.
 */
async function autoSizeGuided(a) {
  const { space, evaluate, evaluateOpt, tick, onProgress } = a;
  const AZ = CONSTANTS.AUTOSIZE;
  const results = [];
  const seen = new Set();
  const key = (c) => `${c.kWp}|${c.windKW}|${c.bessKW}|${c.hours}|${c.units}`;
  const round100 = (v) => Math.round(v / 100) * 100;
  const clip = (v, max) => Math.max(0, Math.min(v, max));

  const mk = (kWp, windKW, bessKW, hours, units, why) => {
    const p = space.pv.include ? round100(clip(kWp, space.pv.maxKWp)) : 0;
    const w = space.wind.include ? round100(clip(windKW, space.wind.maxKW)) : 0;
    const b = space.bess.include ? round100(clip(bessKW, space.bess.hardCapKW !== undefined ? space.bess.hardCapKW : space.bess.maxKW)) : 0;
    const h = b > 0 ? hours : 0;
    const u = space.engine.include ? Math.max(0, Math.min(Math.round(units), space.engine.maxUnits)) : 0;
    return { kWp: p, windKW: w, bessKW: b, hours: h, bessKWh: b * h, units: u, why };
  };

  const pending = [];
  const push = (c) => { const k = key(c); if (!seen.has(k) && results.length + pending.length < AZ.MAX_CANDIDATES) { seen.add(k); pending.push(c); } };

  let done = 0, planned = 0;
  const evalPending = async () => {
    planned += pending.length;
    while (pending.length) {
      const batch = pending.splice(0, 8);
      for (const c of batch) { results.push({ ...c, ...evaluate(c) }); done++; }
      if (onProgress) onProgress(done / Math.max(1, planned));
      if (tick) await tick();
    }
  };
  const rank = (list) => [...list].sort((x, y) => (x.feasible === y.feasible ? x.lcoe - y.lcoe : (x.feasible ? -1 : 1)));

  /* Stage 1 — coarse pass over the anchor-derived levels */
  const pvL = space.pv.include ? space.pv.levelsKWp : [0];
  const wiL = space.wind.include ? space.wind.levelsKW : [0];
  const beL = space.bess.include ? space.bess.levelsKW : [0];
  const duL = space.bess.include ? space.bess.durationsH : [0];
  const enL = space.engine.include ? space.engine.levels : [0];
  for (const p of pvL) for (const w of wiL) for (const b of beL)
    for (const h of (b > 0 ? duL : [0])) for (const u of enL)
      push(mk(p, w, b, h, u, "coarse pass over anchor-derived sizes"));
  await evalPending();
  const coarseTried = results.length;

  /* Stage 2 — coordinate refinement around the leader. When the leader survives
     a round unchanged the step is halved rather than the search stopped: a
     ±25 % step straddles shallow optima, and one or two halvings recover the
     point in between for a handful of extra screening evaluations. */
  let step = AZ.REFINE_STEP_PCT / 100;
  const ladder = AZ.BESS_DURATION_LADDER_H;
  for (let round = 0; round < AZ.REFINE_ROUNDS; round++) {
    const leader = rank(results)[0];
    if (!leader) break;
    const why = `refinement around the leading design (round ${round + 1}, ±${Math.round(step * 100)} %)`;
    if (space.pv.include && leader.kWp > 0) {
      push(mk(leader.kWp * (1 - step), leader.windKW, leader.bessKW, leader.hours || duL[0], leader.units, why));
      push(mk(leader.kWp * (1 + step), leader.windKW, leader.bessKW, leader.hours || duL[0], leader.units, why));
    }
    if (space.wind.include && leader.windKW > 0) {
      push(mk(leader.kWp, leader.windKW * (1 - step), leader.bessKW, leader.hours || duL[0], leader.units, why));
      push(mk(leader.kWp, leader.windKW * (1 + step), leader.bessKW, leader.hours || duL[0], leader.units, why));
    }
    if (space.bess.include && leader.bessKW > 0) {
      push(mk(leader.kWp, leader.windKW, leader.bessKW * (1 - step), leader.hours, leader.units, why));
      push(mk(leader.kWp, leader.windKW, leader.bessKW * (1 + step), leader.hours, leader.units, why));
      const di = ladder.indexOf(leader.hours);
      const neigh = di === -1 ? ladder : [ladder[di - 1], ladder[di + 1]].filter(Boolean);
      for (const h of neigh) push(mk(leader.kWp, leader.windKW, leader.bessKW, h, leader.units, why));
    }
    if (space.engine.include && leader.units > 0) {
      push(mk(leader.kWp, leader.windKW, leader.bessKW, leader.hours, leader.units - 1, why));
      push(mk(leader.kWp, leader.windKW, leader.bessKW, leader.hours, leader.units + 1, why));
    }
    if (!pending.length) break;
    const before = rank(results)[0];
    await evalPending();
    const after = rank(results)[0];
    if (before && after && key(before) === key(after)) {
      step /= 2; // the leader survived its neighbours — tighten the bracket
      if (step * 100 < AZ.REFINE_STEP_MIN_PCT) break;
    }
  }
  const refineTried = results.length - coarseTried;

  /* Stage 2b — ablation of the selected design: for every asset the leader
     carries, evaluate the identical design without it (and, for every asset it
     excludes, the identical design with the smallest tested size of it). This
     pins the marginal-contribution comparison to the selected design itself
     rather than to whatever the coarse grid happened to test. */
  const ablationTwins = (leader, why) => {
    const twins = [];
    if (space.pv.include) twins.push(mk(leader.kWp > 0 ? 0 : (space.pv.levelsKWp.find((v) => v > 0) || 0),
      leader.windKW, leader.bessKW, leader.hours, leader.units, why));
    if (space.wind.include) twins.push(mk(leader.kWp, leader.windKW > 0 ? 0 : (space.wind.levelsKW.find((v) => v > 0) || 0),
      leader.bessKW, leader.hours, leader.units, why));
    if (space.bess.include) twins.push(leader.bessKW > 0
      ? mk(leader.kWp, leader.windKW, 0, 0, leader.units, why)
      : mk(leader.kWp, leader.windKW, space.bess.levelsKW.find((v) => v > 0) || 0, space.bess.durationsH[0], leader.units, why));
    if (space.engine.include) twins.push(mk(leader.kWp, leader.windKW, leader.bessKW, leader.hours,
      leader.units > 0 ? 0 : (space.engine.levels.find((v) => v > 0) || 0), why));
    return twins;
  };
  {
    const leader = rank(results)[0];
    if (leader) {
      for (const t of ablationTwins(leader, "ablation of the selected design")) push(t);
      await evalPending();
    }
  }

  /* Stage 3 — re-price the shortlist under optimisation, if that is the headline
     method. Merit-order screening under-values a battery that earns its keep on
     price arbitrage, so the shortlist is deliberately diversified across the
     storage axis: the best screened design at every distinct storage power is
     re-priced, then the remaining slots go to the overall screening order. */
  let shortlisted = 0;
  const reprice = async (r) => {
    if (r.lcoeOpt !== undefined) return;
    const o = evaluateOpt(r);
    r.lcoeOpt = o.lcoe;
    r.renewablePctOpt = o.renewablePct;
    r.method = "optimised";
    shortlisted++;
    if (onProgress) onProgress(1);
    if (tick) await tick();
  };
  if (evaluateOpt) {
    const feas = rank(results).filter((r) => r.feasible);
    const perBess = new Map();
    for (const r of feas) if (!perBess.has(r.bessKW)) perBess.set(r.bessKW, r);
    const shortlist = [...perBess.values()];
    for (const r of feas) {
      if (shortlist.length >= AZ.OPT_SHORTLIST) break;
      if (!shortlist.includes(r)) shortlist.push(r);
    }
    for (const r of shortlist.slice(0, Math.max(AZ.OPT_SHORTLIST, perBess.size))) await reprice(r);

    /* One refinement round on the optimisation side: the storage neighbours of
       the optimised leader, priced under optimisation directly, since the
       screening order that guided refinement so far cannot see arbitrage value. */
    const optLeader = results.filter((r) => r.lcoeOpt !== undefined).sort((x, y) => x.lcoeOpt - y.lcoeOpt)[0];
    if (optLeader) {
      const stepB = Math.max(100, round100(Math.max(optLeader.bessKW, bessSmallest(space)) * AZ.REFINE_STEP_PCT / 100));
      const cands = [];
      const ladder = AZ.BESS_DURATION_LADDER_H;
      const li = ladder.indexOf(optLeader.hours);
      if (optLeader.bessKW > 0) {
        cands.push(mk(optLeader.kWp, optLeader.windKW, optLeader.bessKW + stepB, optLeader.hours, optLeader.units, "storage neighbour of the optimised leader"));
        cands.push(mk(optLeader.kWp, optLeader.windKW, Math.max(0, optLeader.bessKW - stepB), optLeader.hours, optLeader.units, "storage neighbour of the optimised leader"));
        if (li >= 0 && li + 1 < ladder.length) cands.push(mk(optLeader.kWp, optLeader.windKW, optLeader.bessKW, ladder[li + 1], optLeader.units, "duration neighbour of the optimised leader"));
        if (li > 0) cands.push(mk(optLeader.kWp, optLeader.windKW, optLeader.bessKW, ladder[li - 1], optLeader.units, "duration neighbour of the optimised leader"));
      } else {
        cands.push(mk(optLeader.kWp, optLeader.windKW, bessSmallest(space), AZ.BESS_DURATIONS_H[0], optLeader.units, "storage neighbour of the optimised leader"));
      }
      for (const c of cands) push(c);
      await evalPending();
      for (const r of results.filter((x) => x.feasible && x.lcoeOpt === undefined &&
        (x.why === "storage neighbour of the optimised leader" || x.why === "duration neighbour of the optimised leader"))) await reprice(r);
    }

    /* Ablation of the final optimised selection, re-priced on the same basis,
       so the marginal-contribution table speaks about the design actually
       recommended and in the prices actually quoted. */
    const finalOpt = results.filter((r) => r.lcoeOpt !== undefined).sort((x, y) => x.lcoeOpt - y.lcoeOpt)[0];
    if (finalOpt) {
      const twins = ablationTwins(finalOpt, "ablation of the selected design (optimised basis)");
      const twinKeys = new Set(twins.map((t) => key(t)));
      for (const t of twins) push(t);
      await evalPending();
      for (const r of results.filter((x) => x.feasible && x.lcoeOpt === undefined && twinKeys.has(key(x)))) await reprice(r);
    }
  }

  const feasible = results.filter((r) => r.feasible).sort((x, y) => x.lcoe - y.lcoe);
  const repriced = results.filter((r) => r.lcoeOpt !== undefined).sort((x, y) => x.lcoeOpt - y.lcoeOpt);
  const best = evaluateOpt ? (repriced[0] || feasible[0] || null) : (feasible[0] || null);
  return { all: results, feasible, ranked: rank(results), best, tried: results.length,
    coarseTried, refineTried, shortlisted };
}

function bessSmallest(space) {
  const v = (space.bess.levelsKW || []).find((x) => x > 0);
  return v || round100(space.bess.anchors ? space.bess.anchors.fallbackKW : 0) || 100;
}

/**
 * MARGINAL CONTRIBUTION OF EACH ASSET CLASS — for the winning design, what does
 * each asset actually buy? Compares the winner against the best feasible design
 * that excludes the asset class entirely (both priced on the screening basis,
 * so the comparison is like for like). This is what makes "storage does not
 * pay" a stated result rather than something read between the lines.
 */
function assetContribution(results, best, space) {
  if (!best) return [];
  const axes = [
    { id: "pv", label: "Solar PV", val: (r) => r.kWp, inSearch: space.pv.include, size: (r) => `${(r.kWp / 1000).toFixed(1)} MWp` },
    { id: "wind", label: "Wind", val: (r) => r.windKW, inSearch: space.wind.include, size: (r) => `${(r.windKW / 1000).toFixed(1)} MW` },
    { id: "bess", label: "Battery storage", val: (r) => r.bessKW, inSearch: space.bess.include, size: (r) => `${(r.bessKW / 1000).toFixed(1)} MW / ${(r.bessKWh / 1000).toFixed(1)} MWh` },
    { id: "engine", label: "Engine generation", val: (r) => r.units, inSearch: space.engine.include, size: (r) => `${r.units} units` },
  ];
  /* Basis discipline: the comparison must be priced the same way the selection
     was. When the winner was selected on optimised dispatch, alternatives are
     drawn from the re-priced pool only — mixing screening and optimised prices
     in one table would overstate whichever side the reader is not warned about. */
  const basisOpt = best.lcoeOpt !== undefined;
  const price = (r) => (basisOpt ? r.lcoeOpt : r.lcoe);
  const renew = (r) => (basisOpt && r.renewablePctOpt !== undefined ? r.renewablePctOpt : r.renewablePct);
  const feasible = results.filter((r) => r.feasible && (!basisOpt || r.lcoeOpt !== undefined));
  return axes.filter((ax) => ax.inSearch).map((ax) => {
    const inWinner = ax.val(best) > 0;
    const pool = feasible.filter((r) => (inWinner ? ax.val(r) === 0 : ax.val(r) > 0));
    const alt = pool.length ? pool.reduce((m, r) => (price(r) < price(m) ? r : m)) : null;
    if (!alt) {
      return { id: ax.id, label: ax.label, inWinner, size: inWinner ? ax.size(best) : "—",
        deltaLCOE: null, deltaRenew: null, deltaCapex: null,
        note: inWinner ? (basisOpt ? "required — no re-priced design excludes it" : "required — no design passed the checks without it")
          : "no feasible design includes it" };
    }
    // positive delta = the winner is cheaper than the alternative, i.e. the choice pays
    const deltaLCOE = +(price(alt) - price(best)).toFixed(1);
    const deltaRenew = +(renew(best) - renew(alt)).toFixed(1);
    const deltaCapex = +((best.capexMEUR || 0) - (alt.capexMEUR || 0)).toFixed(2);
    const note = inWinner
      ? (deltaLCOE >= 0 ? `pays: best design without it is ${deltaLCOE.toFixed(1)} €/MWh dearer`
        : `does not pay on LCOE: dropping it saves ${(-deltaLCOE).toFixed(1)} €/MWh but gives up ${deltaRenew.toFixed(1)} pp renewable share`)
      : (deltaLCOE >= 0 ? `correctly excluded: best design with it is ${deltaLCOE.toFixed(1)} €/MWh dearer`
        : `excluded, but the best design with it is ${(-deltaLCOE).toFixed(1)} €/MWh cheaper — inspect the ranking`);
    return { id: ax.id, label: ax.label, inWinner, size: inWinner ? ax.size(best) : ax.size(alt) + " (best alternative)",
      deltaLCOE, deltaRenew, deltaCapex, altKey: alt, note };
  });
}

/* --- Excel export ---------------------------------------------------------- */

function exportWorkbook(a) {
  const { XLSX, ctx, loc, res, costs, disp, cost, adeq, bom, fin, financials, baseline,
    stats, mode, aidc, aidcDerived, cal, load, price, sens, scenarios, resourceSource, autoRank } = a;
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name.slice(0, 31));

  add("Assumptions", [
    ["Microgrid design tool — pre-feasibility. Not a protection study, an EMT study, or a contractor's price."],
    ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ")],
    [],
    ["Parameter", "Value", "Unit", "Source"],
    ["Use-case family", ctx.useCase, "-", "user"],
    ["Grid status", ctx.gridStatus, "-", "user"],
    ["Import cap in force", a.firmCapKW, "kW", "user"],
    ["Export cap", ctx.exportCapKW, "kW", "user"],
    ["Islanding requirement", ctx.islanding, "-", "user"],
    ["Required autonomy", ctx.autonomyH, "h", "user"],
    ["Location", loc.label, "-", "library"],
    ["Specific yield", loc.specificYield_kWh_per_kWp, "kWh/kWp/yr", resourceSource.pv === "site" ? "uploaded site data" : "library default"],
    ["Yield uncertainty band", resourceSource.pv === "site" ? CONSTANTS.SITE_YIELD_UNCERTAINTY_PCT : CONSTANTS.LIBRARY_YIELD_UNCERTAINTY_PCT, "± %", "constant"],
    ["Mean wind speed at 100 m", loc.windMean_m_s_100m, "m/s", "library"],
    ["Grid emission factor", loc.gridCO2_g_per_kWh, "gCO2/kWh", "library"],
    ["Import tariff", loc.importTariff_EUR_per_MWh, "EUR/MWh", "library"],
    ["Grid fees", loc.gridFee_EUR_per_MWh, "EUR/MWh", "library"],
    ["Capacity charge", loc.capacityCharge_EUR_per_kW_yr, "EUR/kW/yr", "library"],
    ["Diesel price", loc.diesel_EUR_per_litre, "EUR/l", "library"],
    ["Gas price", loc.gas_EUR_per_MWh_th, "EUR/MWh th", "library"],
    ["Project life", ctx.lifeYears, "years", "user"],
    ["Discount rate, real", ctx.discountPct, "%/yr", "user"],
    [],
    ["Mode", mode === "aidc" ? "AIDC design" : "Standard project", "-", "user"],
    ...(mode === "aidc" ? [
      ["Target IT capacity", aidc.targetMWIT, "MW IT", "user"],
      ["Analysis year", aidc.analysisYear, "-", "user"],
      ["Cooling type", aidc.coolingType, "-", "user"],
      ["Design PUE", aidc.designPUE, "-", "user"],
      ["Annualised PUE", aidcDerived ? aidcDerived.annualisedPUE : "", "-", "derived"],
      ["Free-cooling hours", aidcDerived ? aidcDerived.freeHours : "", "h/yr", "derived"],
      ["Redundancy", aidc.redundancy, "-", "user"],
      ["Land available for PV", aidc.landPV_ha, "ha", "user"],
      ["Permitted engine hours", aidc.engineHoursLimit, "h/yr", "user"],
    ] : []),
    [],
    ["Resource", "In use", "Rating", "Unit"],
    ["PV", res.pv.enabled ? "yes" : "no", res.pv.kWp, "kWp"],
    ["PV DC/AC ratio", "", res.pv.dcacRatio, "kWp/kW"],
    ["PV degradation", "", res.pv.degradationPctPerYr, "%/yr"],
    ["Wind", res.wind.enabled ? "yes" : "no", res.wind.ratedKW, "kW"],
    ["BESS power", res.bess.enabled ? "yes" : "no", res.bess.powerKW, "kW"],
    ["BESS energy", "", res.bess.energyKWh, "kWh"],
    ["BESS reserve SOC", "", res.bess.reserveSocPct, "%"],
    ["BESS round-trip efficiency", "", res.bess.rtePct, "%"],
    ["BESS grid-forming", "", res.bess.gridForming ? "yes" : "no", "-"],
    ["Engines", res.engine.enabled ? "yes" : "no", res.engine.units, "units"],
    ["Engine unit rating", "", res.engine.unitKW, "kW"],
    ["Engine minimum stable load", "", res.engine.minStableLoadPct, "%"],
    ["Engine permitted hours", "", res.engine.annualHourLimit, "h/yr"],
    ["Turbine", res.turbine.enabled ? "yes" : "no", res.turbine.ratedKW, "kW"],
    [],
    ["Cost assumption", "Value", "Unit", "Default?"],
    ...Object.keys(CONSTANTS.COST_DEFAULTS).map((k) => [k, costs[k], "", String(costs[k]) === String(CONSTANTS.COST_DEFAULTS[k]) ? "default" : "overridden"]),
  ]);

  add("Location & resource", [
    ["Month", "PV yield share", "PV yield kWh/kWp", "Mean dry bulb C"],
    ...loc.tempMeanC.map((t, i) => {
      const tot = loc.monthlyYieldShare.reduce((x, y) => x + y, 0);
      return [i + 1, loc.monthlyYieldShare[i], loc.monthlyYieldShare[i] / tot * loc.specificYield_kWh_per_kWp, t];
    }),
  ]);

  const hourHeader = ["Hour", "Month", "Day of year", "Hour of day", "Load kW", "PV kW", "Wind kW",
    "Grid import kW", "Grid export kW", "BESS kW (+dis/-chg)", "SOC %", "Engine kW", "Engines on",
    "Turbine kW", "Aux kW", "Curtailed kW", "Shed kW", "Unserved kW", "Ambient C", "Import price EUR/MWh", "Reason code", "Reason"];
  const hourRows = [hourHeader];
  for (let i = 0; i < H; i++) {
    const code = REASON_CODES[disp.reason[i]];
    hourRows.push([i, cal.month[i] + 1, cal.doy[i] + 1, cal.hourOfDay[i],
      +load[i].toFixed(1), +disp.pv[i].toFixed(1), +disp.wind[i].toFixed(1),
      +disp.imp[i].toFixed(1), +disp.exp[i].toFixed(1), +disp.bess[i].toFixed(1), +disp.soc[i].toFixed(2),
      +disp.engine[i].toFixed(1), disp.enginesOn[i], +disp.turbine[i].toFixed(1), +disp.aux[i].toFixed(1),
      +disp.curtail[i].toFixed(1), +(disp.shed1[i] + disp.shed2[i]).toFixed(1), +disp.unserved[i].toFixed(1),
      +a.temp[i].toFixed(1), +price[i].toFixed(2), code, REASON_INFO[code].label]);
  }
  add("Hourly dispatch", hourRows);

  add("Load profile", [["Hour", "Load kW"], ...Array.from({ length: H }, (_, i) => [i, +load[i].toFixed(1)])]);
  add("Generation profiles", [["Hour", "PV kW", "Wind kW"], ...Array.from({ length: H }, (_, i) => [i, +disp.pv[i].toFixed(1), +disp.wind[i].toFixed(1)])]);

  add("Engine self-test", a.selfTestOut
    ? [["Check", "Verdict", "What is verified", "Worst value", "Hour", "Failing hours"],
       ...a.selfTestOut.checks.map((c) => [c.name, c.pass ? "PASS" : "FAIL", c.detail, c.worst, c.worstHour, c.fails])]
    : [["No self-test recorded."]]);

  add("Dispatch quality", a.diagOut
    ? [["Finding", "Value", "Verdict", "Note"],
       ...a.diagOut.findings.map((f) => [f.name, f.value, f.good ? "OK" : "ROOM", f.note]),
       [], ["Peak import achieved kW", a.diagOut.achievedPeakKW],
       ["Best achievable peak kW", a.diagOut.achievablePeakKW],
       ["Gap kW", a.diagOut.peakGapKW], ["Gap value EUR/yr", a.diagOut.peakGapEUR]]
    : [["No diagnostics recorded."]]);

  add("Sizing & BOM", [
    ["Item", "Qty", "Rating", "Note"],
    ...bom.rows.map((r) => [r.item, r.qty, r.rating, r.note]),
    [],
    ["Total installed capacity", bom.installedMW, "MW"],
    ["PV area required", bom.pvAreaM2 / CONSTANTS.M2_PER_HA, "ha"],
    ["BESS footprint", bom.bessAreaM2, "m2"],
    ["Engine footprint", bom.engineAreaM2, "m2"],
  ]);

  add("Phased build-out", a.phaseRows && a.phaseRows.length
    ? [["Year", "MW IT", "Facility peak MW", "Import cap MW", "Engines needed", "Engine min load MW",
        "Below min load?", "Unserved MWh", "Energy", "Power", "Dynamic"],
       ...a.phaseRows.map((p) => [p.year, p.mwIT, p.peakMW, p.capMW, p.enginesNeeded, p.engineMinMW,
        p.belowMinLoad ? "YES" : "no", p.unservedMWh, p.energy, p.power, p.dynamic])]
    : [["Phased build-out applies to AIDC design mode with a ramp defined."]]);

  add("Adequacy checks", [
    ["Check", "Verdict", "Governing number"],
    ["Energy", adeq.energy.verdict, adeq.energy.governing],
    ["Power", adeq.power.verdict, adeq.power.governing],
    ["Dynamic", adeq.dynamic.verdict, adeq.dynamic.governing],
    [],
    ["Energy adequacy detail", "", ""],
    ["Unserved energy", adeq.energy.unservedMWh, "MWh/yr"],
    ["Load shed", adeq.energy.shedMWh, "MWh/yr"],
    ["Island load", adeq.energy.islandLoadKW, "kW"],
    ["Stored energy usable in island", adeq.energy.islandKWh, "kWh"],
    ["Autonomy achieved", adeq.energy.autonomyFromBessH, "h"],
    ["Autonomy required", adeq.energy.autonomyRequiredH, "h"],
    ["Worst renewable window share", adeq.energy.worstRenewableShare, "-"],
    ["Worst window deficit", adeq.energy.worstDeficitMWh, "MWh"],
    [],
    ["Power adequacy detail", "", ""],
    ["Coincident peak", adeq.power.coincidentPeakKW, "kW"],
    ["Firm capacity", adeq.power.firmKW, "kW"],
    ["Largest unit", adeq.power.largestUnit ? adeq.power.largestUnit.name : "-", adeq.power.largestUnit ? adeq.power.largestUnit.kW : 0],
    ["Firm after N-1", adeq.power.firmAfterN1KW, "kW"],
    ["Margin", adeq.power.marginKW, "kW"],
    ["Loses grid-forming source", adeq.power.losesGridForming ? "YES" : "no", ""],
    [],
    ["Dynamic adequacy detail", "", ""],
    ["Governing step", adeq.dynamic.worstStepKW, "kW"],
    ["Fast response available", adeq.dynamic.fastResponseKW, "kW"],
    ["System inertia", adeq.dynamic.inertiaMWs, "MW.s"],
    ["RoCoF", adeq.dynamic.rocof, "Hz/s"],
    ["Frequency nadir", adeq.dynamic.nadirHz, "Hz"],
  ]);

  add("LCOE breakdown", [
    ["LCOE at facility busbar", cost.lcoeFacility, "EUR/MWh"],
    ...(cost.itEnergyMWh > 0 ? [["LCOE delivered to IT", cost.lcoeIT, "EUR/MWh"]] : []),
    ["NPV of lifetime cost", cost.npvCost, "EUR"],
    ["Discounted energy served", cost.npvEnergyFacility, "MWh"],
    ["Energy served, year 1", cost.servedMWh, "MWh/yr"],
    [],
    ["Capital cost by component", "EUR", "EUR/MWh"],
    ...cost.breakdown.map((b) => [b.name, b.capex, b.lcoe]),
    ["Total capex", cost.capex.total, ""],
    [],
    ["Discounted lifetime operating cost", "EUR", "EUR/MWh"],
    ...cost.opexBreakdown.map((b) => [b.name, b.value, b.lcoe]),
  ]);

  add("Sensitivity", [["Change %", "Yield EUR/MWh", "Capex EUR/MWh", "Fuel EUR/MWh", "Discount EUR/MWh"],
    ...sens.map((p) => [p.delta, p.yield, p.capex, p.fuel, p.discount])]);

  add("Cashflow", fin.enabled && financials
    ? [["Baseline", baseline.label], ["Baseline annual cost", baseline.annualCost, "EUR/yr"], [],
       ["Year", "Baseline cost EUR", "Project opex EUR", "Net saving EUR", "Debt service EUR", "DSCR", "Cumulative EUR"],
       ...financials.rows.map((r) => [r.year, r.baselineCost, r.projectOpex, r.saving, r.debtService, r.dscr, r.cumulative]),
       [], ["NPV", financials.npv, "EUR"], ["IRR", financials.irr, "-"],
       ["Equity IRR", financials.equityIrr, "-"], ["Simple payback", financials.paybackYears, "years"],
       ["Minimum DSCR", financials.minDSCR, "-"]]
    : [["The financial model is switched off. Enable it on the Report tab to populate this sheet."]]);

  add("Scenario comparison", scenarios.length
    ? [["Scenario", "PV MWp", "BESS MW", "BESS MWh", "Engines", "LCOE EUR/MWh", "Renewable %", "Fuel", "Unserved MWh",
        "Energy", "Power", "Dynamic", "Capex EUR", "NPV EUR"],
       ...scenarios.map((s) => [s.name, s.pvMWp, s.bessMW, s.bessMWh, s.engines, s.lcoe, s.renewablePct, s.fuel,
        s.unservedMWh, s.energy, s.power, s.dynamic, s.capex, s.npv])]
    : [["No scenarios saved. Save up to six on the Scenarios tab."]]);

  add("Auto-size ranking", autoRank && autoRank.length
    ? [["Rank", "PV MWp", "BESS MW", "BESS MWh", "Engine units", "LCOE EUR/MWh", "Renewable %", "Unserved MWh", "Feasible"],
       ...autoRank.map((r, i) => [i + 1, r.kWp / 1000, r.bessKW / 1000, r.bessKWh / 1000, r.units,
        r.lcoe, r.renewablePct, r.unservedMWh, r.feasible ? "yes" : "no"])]
    : [["Run the sweep on the Auto-size tab to populate this sheet."]]);

  XLSX.writeFile(wb, `microgrid-design-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/* ============================================================================
   PROJECT CONFIGURATION FILE
   A plain JSON snapshot of everything a project needs to be reproduced,
   including any uploaded load or resource series. Human-readable on purpose:
   a reviewer can diff two project files in a text editor.
   ========================================================================== */
const CONFIG_SCHEMA_VERSION = 1;

function buildConfig(a) {
  return {
    schema: CONFIG_SCHEMA_VERSION,
    tool: "microgrid-design-tool",
    savedAt: new Date().toISOString(),
    projectName: a.projectName || "",
    notes: a.projectNotes || "",
    mode: a.mode,
    ctx: a.ctx,
    locationId: a.ctx.locationId,
    locOverride: a.locOverride,
    aidc: a.aidc,
    loadCfg: a.loadCfg,
    char: a.char,
    res: a.res,
    costs: a.costs,
    fin: a.fin,
    sweep: a.sweep,
    lcoeBoundary: a.lcoeBoundary,
    scenarios: a.scenarios,
    // Uploaded series travel with the file, otherwise the project cannot be reproduced
    uploadedLoad: a.csvResult && a.csvResult.load ? Array.from(a.csvResult.load).map((v) => +v.toFixed(2)) : null,
    uploadedLoadNotes: a.csvResult ? a.csvResult.notes : null,
    uploadedPrice: a.uploadedPrice ? Array.from(a.uploadedPrice).map((v) => +v.toFixed(3)) : null,
    uploadedResource: a.uploadedResource ? {
      pvUnit: a.uploadedResource.pvUnit ? Array.from(a.uploadedResource.pvUnit).map((v) => +v.toFixed(5)) : null,
      temp: a.uploadedResource.temp ? Array.from(a.uploadedResource.temp).map((v) => +v.toFixed(2)) : null,
    } : null,
    resourceSource: a.resourceSource,
  };
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const el = document.createElement("a");
  el.href = url; el.download = filename;
  document.body.appendChild(el); el.click();
  document.body.removeChild(el); URL.revokeObjectURL(url);
}

/** Returns { ok, config, messages } — never throws on a bad file. */
function parseConfig(text) {
  const messages = [];
  let cfg;
  try { cfg = JSON.parse(text); } catch (err) { return { ok: false, messages: ["The file is not valid JSON."] }; }
  if (cfg.tool !== "microgrid-design-tool") messages.push("This file was not written by this tool — loading it anyway, values may be ignored.");
  if (cfg.schema !== CONFIG_SCHEMA_VERSION) messages.push(`Saved with schema ${cfg.schema ?? "unknown"}, this build expects ${CONFIG_SCHEMA_VERSION}. Missing fields keep their current values.`);
  const required = ["ctx", "res", "char"];
  for (const k of required) if (!cfg[k]) messages.push(`Missing section "${k}" — leaving the current values in place.`);
  if (cfg.uploadedLoad && cfg.uploadedLoad.length !== CONSTANTS.HOURS_PER_YEAR)
    messages.push(`Embedded load series has ${cfg.uploadedLoad.length} values, expected ${CONSTANTS.HOURS_PER_YEAR} — ignored.`);
  return { ok: true, config: cfg, messages };
}

/* ============================================================================
   OPTIMISED DISPATCH — dynamic programming over state of charge
   ============================================================================
   The merit order is myopic by construction: it serves load in a fixed
   sequence and cannot know that power is about to be free, or that tonight is
   expensive. On a market tariff that is the wrong answer — when prices go
   negative the right move is to import at full cap and fill the battery, then
   displace the expensive evening entirely.

   This routine finds the genuinely cheapest battery schedule for the year by
   backward dynamic programming over a discretised state of charge. It is not a
   heuristic and not a rule: for the given discretisation it returns the optimal
   policy, because DP evaluates every reachable state at every hour.

   What is optimised : the battery — when to charge, from where, and when to
                       discharge, against the actual hourly price.
   What is not       : engine unit commitment. Deciding which discrete units run
                       for which hours, with minimum up and down times, is an
                       integer program. Engines are dispatched by the same
                       deterministic rules afterwards, so their behaviour stays
                       readable and every engine hour is still auditable.

   Cost seen by the optimiser, per hour:
     import at the hour's price, up to the connection cap
     above the cap, engine energy at its marginal fuel cost
     above that, unserved energy at the value of lost load
     export credited at the export price, up to the export cap
     every kWh through the battery charged at its wear cost, so it does not
     cycle for a gain smaller than the damage it does
   ==========================================================================*/

function optimiseDispatch(cfg) {
  const { load, pvGen, windGen, price, temp, cal } = cfg;
  const g = cfg.grid, b = cfg.bess, e = cfg.engine, t = cfg.turbine;
  const opt = cfg.optimiser || {};
  // The policy is stored in an Int8Array, so a level change must stay inside
  // ±127. NS − 1 is the largest change the recursion can propose, hence the
  // upper clamp; below 11 levels the discretisation stops being meaningful.
  const NS = Math.min(CONSTANTS.OPT_SOC_LEVELS_MAX,
    Math.max(CONSTANTS.OPT_SOC_LEVELS_MIN, Math.round(opt.socLevels || CONSTANTS.OPT_SOC_LEVELS)));

  /* --- Residual demand after renewables, and the surplus available --------- */
  const resid = new Float32Array(H), surplus = new Float32Array(H);
  for (let i = 0; i < H; i++) {
    const ren = (pvGen ? pvGen[i] : 0) + (windGen ? windGen[i] : 0);
    const d = load[i] - ren;
    resid[i] = d > 0 ? d : 0;
    surplus[i] = d < 0 ? -d : 0;
  }

  /* --- Marginal cost of a kWh from each source, hour by hour --------------- */
  // Same definition the dispatch, the search-space proposal and the screen use.
  // It honours the fuel curves carried on the engine, evaluates at the stated
  // load point and includes variable O&M — the local copy this replaced did
  // none of those three, so the optimiser priced engine energy below the plant.
  const engineMarginal = e.enabled
    ? engineMarginalCostEURperMWh(e, cfg.dieselPrice, cfg.gasPrice)
    : Infinity;
  const engineCapKW = e.enabled ? e.units * e.unitKW : 0;
  const turbCapKW = t.enabled ? t.ratedKW : 0;
  const wearEURperKWh = (b.wearCostEURperMWh !== undefined ? b.wearCostEURperMWh : CONSTANTS.BESS_WEAR_COST_EUR_PER_MWH) / 1000;

  /** Cost of meeting `need` kW in hour i from grid, then engines, then unserved. */
  const supplyCost = (i, need, capKW) => {
    if (need <= 0) {
      // surplus: export what the cap allows, the rest is curtailed at no value
      const exp = Math.min(-need, g.enabled ? g.exportCapKW : 0);
      return -exp * (cfg.exportPrice || 0) / 1000;
    }
    let c = 0, left = need;
    const imp = Math.min(left, capKW);
    c += imp * price[i] / 1000; left -= imp;
    if (left > 0 && engineCapKW + turbCapKW > 0) {
      const eng = Math.min(left, engineCapKW + turbCapKW);
      c += eng * engineMarginal / 1000; left -= eng;
    }
    if (left > 0) c += left * CONSTANTS.VALUE_OF_LOST_LOAD_EUR_PER_MWH / 1000;
    return c;
  };

  /* --- Discretisation ------------------------------------------------------ */
  const socLo = b.socMinPct, socHi = b.socMaxPct;
  const floorPct = b.reserveApplies ? Math.max(socLo, b.reserveSocPct) : socLo;
  const kWhPerLevel = b.energyKWh * (socHi - socLo) / 100 / (NS - 1);
  const powerLimitKW = Math.min(b.powerKW, b.energyKWh * b.cRate);
  const maxLevels = kWhPerLevel > 0 ? Math.floor(powerLimitKW / kWhPerLevel) : 0;
  const effOneWay = Math.sqrt(b.rteFraction);
  const levelPct = (k) => socLo + k * (socHi - socLo) / (NS - 1);
  const floorLevel = Math.ceil((floorPct - socLo) / ((socHi - socLo) / (NS - 1)) - 1e-9);

  // Peak-shaving is a monthly charge and therefore not separable hour by hour.
  // It is handled by the caller, which tightens an import ceiling and re-runs.
  const ceilingKW = cfg.importCeilingKW && cfg.importCeilingKW > 0
    ? Math.min(g.enabled ? g.importCapKW : 0, cfg.importCeilingKW)
    : (g.enabled ? g.importCapKW : 0);

  if (!b.enabled || b.energyKWh <= 0 || maxLevels < 1) {
    return { ok: false, reason: "No battery to optimise — the merit order and the optimum are the same thing here." };
  }

  /* --- Backward pass: value of holding each level at each hour ------------- */
  // Two rolling rows only; the policy is recomputed on the forward pass.
  let next = new Float64Array(NS), curr = new Float64Array(NS);
  const BIG = 1e15;
  // Terminal: end the year at or above the starting level, so the optimiser
  // cannot flatter itself by selling the battery empty.
  const startLevel = Math.max(floorLevel, Math.round((b.startSocPct - socLo) / ((socHi - socLo) / (NS - 1))));
  for (let k = 0; k < NS; k++) next[k] = k >= startLevel ? 0 : BIG;

  const policy = new Int8Array(H * NS);   // level change chosen, per hour and state

  for (let i = H - 1; i >= 0; i--) {
    const capKW = (g.nonFirm && g.curtailFlags[i]) ? Math.min(ceilingKW, g.reducedCapKW) : ceilingKW;
    for (let k = 0; k < NS; k++) {
      if (k < floorLevel) { curr[k] = BIG; continue; }
      let best = BIG, bestMove = 0;
      const lo = Math.max(floorLevel - k, -maxLevels);
      const hi = Math.min(NS - 1 - k, maxLevels);
      for (let m = lo; m <= hi; m++) {
        // m > 0 charges the battery, m < 0 discharges it
        const dLevels = m;
        let batteryKW;            // positive = discharging into the site
        if (dLevels >= 0) batteryKW = -(dLevels * kWhPerLevel) / effOneWay;
        else batteryKW = (-dLevels * kWhPerLevel) * effOneWay;
        const need = resid[i] - surplus[i] - batteryKW;
        const cost = supplyCost(i, need, capKW)
          + Math.abs(dLevels) * kWhPerLevel * wearEURperKWh;
        const total = cost + next[k + dLevels];
        if (total < best) { best = total; bestMove = dLevels; }
      }
      curr[k] = best;
      policy[i * NS + k] = bestMove;
    }
    const swap = next; next = curr; curr = swap;
  }

  return {
    ok: true, policy, NS, kWhPerLevel, effOneWay, startLevel, floorLevel,
    levelPct, bestCost: next[startLevel],
  };
}

/**
 * Run the optimised schedule through the SAME recording machinery as the merit
 * order, so the hourly table, the reason codes and the self-test all still work.
 * The battery follows the DP policy; everything else follows the ordinary rules.
 */
function dispatchOptimised(cfg) {
  const plan = optimiseDispatch(cfg);
  if (!plan.ok) return { ...dispatch(cfg), optimiserNote: plan.reason };

  // Convert the policy into an hourly battery power schedule
  const schedule = new Float32Array(H);
  let k = plan.startLevel;
  for (let i = 0; i < H; i++) {
    const m = plan.policy[i * plan.NS + k];
    if (m >= 0) schedule[i] = -(m * plan.kWhPerLevel) / plan.effOneWay;  // charging
    else schedule[i] = (-m * plan.kWhPerLevel) * plan.effOneWay;         // discharging
    k += m;
  }
  const out = dispatch({ ...cfg, forcedBattery: schedule });
  out.optimiserUsed = true;
  return out;
}

/**
 * Peak charges are billed on each month's maximum, which no hour-by-hour
 * optimisation can see. The ceiling is tightened until the demand-charge saving
 * stops outweighing the extra energy cost — a one-dimensional search over a
 * single number, evaluated with the full optimisation each time.
 */
function optimiseWithDemandCharge(cfg, capacityChargeEURperKWyr, onStep) {
  const evaluate = (ceilingKW) => {
    const r = dispatchOptimised({ ...cfg, importCeilingKW: ceilingKW });
    let energy = 0;
    for (let i = 0; i < H; i++) energy += r.imp[i] * cfg.price[i] / 1000;
    const fuel = cfg.engine.fuelType === "diesel"
      ? r.summary.fuelLitres * (cfg.dieselPrice || 0)
      : r.summary.fuelMWhTh * (cfg.gasPrice || 0);
    const demand = r.summary.meanMonthlyPeakKW * capacityChargeEURperKWyr;
    return { r, total: energy + fuel + demand, energy, fuel, demand };
  };

  const capKW = cfg.grid.enabled ? cfg.grid.importCapKW : 0;
  let best = evaluate(capKW), bestCeiling = capKW;
  if (capacityChargeEURperKWyr > 0 && capKW > 0) {
    for (const frac of CONSTANTS.OPT_CEILING_STEPS) {
      const trial = evaluate(capKW * frac);
      if (onStep) onStep(frac);
      if (trial.total < best.total) { best = trial; bestCeiling = capKW * frac; }
    }
  }
  return { ...best.r, optimiserCeilingKW: bestCeiling, optimiserAnnualCost: best.total };
}

/* ============================================================================
   THEME
   Two palettes. Tailwind's dark: variant needs a build-config change, so the
   palette is resolved in JS instead and passed down through context. Every
   colour in the UI comes from here — no colour class is written inline.
   ========================================================================== */

export const THEMES = {
  dark: {
    key: "dark",
    app: "bg-slate-950 text-slate-200",
    appText: "text-slate-200",
    tabIdle: "border-transparent text-slate-400 hover:border-slate-600",
    stage: {
      Define:   { page: "bg-sky-950",     band: "bg-sky-900",     on: "border-sky-500 bg-sky-800 text-sky-50",         label: "text-sky-300" },
      Analyse:  { page: "bg-violet-950",  band: "bg-violet-900",  on: "border-violet-500 bg-violet-800 text-violet-50", label: "text-violet-300" },
      Optimise: { page: "bg-emerald-950", band: "bg-emerald-900", on: "border-emerald-500 bg-emerald-800 text-emerald-50", label: "text-emerald-300" },
      Report:   { page: "bg-amber-950",   band: "bg-amber-900",   on: "border-amber-500 bg-amber-800 text-amber-50",    label: "text-amber-300" },
    },
    panel: "border-slate-800 bg-slate-900",
    rule: "border-slate-800",
    tile: "border-slate-800 bg-slate-950",
    input: "border-slate-700 bg-slate-950 text-slate-100 focus:border-cyan-500",
    inputSite: "border-amber-800 bg-amber-950 text-amber-50 focus:border-amber-500",
    inputLib: "border-slate-700 bg-slate-950 text-slate-400 focus:border-cyan-500",
    micro: "border-slate-700 bg-slate-950 text-slate-400",
    title: "text-slate-50",
    muted: "text-slate-400",
    faint: "text-slate-500",
    ghost: "text-slate-600",
    divide: "divide-slate-900",
    btn: "border-slate-700 bg-slate-900 text-slate-400",
    btnOn: "bg-cyan-900 text-cyan-200",
    chip: "border-cyan-800 bg-cyan-950 text-cyan-300",
    chipWarn: "bg-amber-950 text-amber-300",
    chipOk: "bg-emerald-950 text-emerald-300",
    chipIdle: "border-slate-800 bg-slate-900 text-slate-600",
    chipAlert: "border-amber-500 bg-amber-600 text-slate-950",
    notice: {
      warn: "border-amber-700 bg-amber-950 text-amber-200",
      info: "border-slate-700 bg-slate-950 text-slate-300",
      fail: "border-rose-700 bg-rose-950 text-rose-200",
    },
    tone: { slate: "text-slate-100", cyan: "text-cyan-300", amber: "text-amber-300", emerald: "text-emerald-300", rose: "text-rose-300", violet: "text-violet-300" },
    critRule: "border-cyan-600",
    critLabel: "text-slate-100",
    advLabel: "text-slate-500",
    termUnderline: "decoration-slate-500",
    head: "text-cyan-300",
    headBg: "bg-slate-900",
    soft: { cyan: "bg-cyan-950", amber: "bg-amber-950", emerald: "bg-emerald-950", violet: "bg-violet-950", rose: "bg-rose-950", slate: "bg-slate-900" },
    lcoeSeg: { capex: ["#22d3ee", "#38bdf8", "#a78bfa", "#818cf8", "#c084fc", "#2dd4bf", "#60a5fa"], opex: ["#fb923c", "#f59e0b", "#f472b6", "#fbbf24", "#fda4af", "#facc15"], credit: "#34d399" },
    chart: { grid: "#1e293b", axis: "#475569", tipBg: "#020617", tipBorder: "#1e293b", load: "#22d3ee", loadFill: "#0e7490", temp: "#f59e0b", pv: "#a78bfa", bar1: "#0e7490", bar2: "#f59e0b", ref: "#64748b", refWarn: "#f43f5e", wind: "#38bdf8", imp: "#06b6d4", bessC: "#a78bfa", engineC: "#fb923c", turbineC: "#f472b6", socC: "#94a3b8", unservedC: "#f43f5e" },
  },
  light: {
    key: "light",
    app: "bg-slate-100 text-slate-800",
    appText: "text-slate-800",
    tabIdle: "border-transparent text-slate-600 hover:border-slate-400",
    stage: {
      Define:   { page: "bg-sky-50",     band: "bg-sky-100",     on: "border-sky-400 bg-sky-200 text-sky-900",         label: "text-sky-700" },
      Analyse:  { page: "bg-violet-50",  band: "bg-violet-100",  on: "border-violet-400 bg-violet-200 text-violet-900", label: "text-violet-700" },
      Optimise: { page: "bg-emerald-50", band: "bg-emerald-100", on: "border-emerald-400 bg-emerald-200 text-emerald-900", label: "text-emerald-700" },
      Report:   { page: "bg-amber-50",   band: "bg-amber-100",   on: "border-amber-400 bg-amber-200 text-amber-900",    label: "text-amber-700" },
    },
    panel: "border-slate-300 bg-white",
    rule: "border-slate-200",
    tile: "border-slate-200 bg-slate-50",
    input: "border-slate-300 bg-white text-slate-900 focus:border-cyan-600",
    inputSite: "border-amber-300 bg-yellow-50 text-slate-900 focus:border-amber-500",
    inputLib: "border-slate-300 bg-white text-slate-500 focus:border-cyan-600",
    micro: "border-slate-300 bg-white text-slate-500",
    title: "text-slate-900",
    muted: "text-slate-600",
    faint: "text-slate-500",
    ghost: "text-slate-400",
    divide: "divide-slate-100",
    btn: "border-slate-300 bg-white text-slate-600",
    btnOn: "bg-cyan-700 text-white",
    chip: "border-cyan-300 bg-cyan-50 text-cyan-800",
    chipWarn: "bg-amber-100 text-amber-800",
    chipOk: "bg-emerald-100 text-emerald-800",
    chipIdle: "border-slate-200 bg-slate-50 text-slate-400",
    chipAlert: "border-amber-600 bg-amber-500 text-white",
    notice: {
      warn: "border-amber-300 bg-amber-50 text-amber-900",
      info: "border-slate-300 bg-slate-50 text-slate-700",
      fail: "border-rose-300 bg-rose-50 text-rose-900",
    },
    tone: { slate: "text-slate-900", cyan: "text-cyan-700", amber: "text-amber-700", emerald: "text-emerald-700", rose: "text-rose-700", violet: "text-violet-700" },
    critRule: "border-cyan-600",
    critLabel: "text-slate-900",
    advLabel: "text-slate-500",
    termUnderline: "decoration-slate-400",
    head: "text-cyan-800",
    headBg: "bg-cyan-50",
    soft: { cyan: "bg-cyan-50", amber: "bg-amber-50", emerald: "bg-emerald-50", violet: "bg-violet-50", rose: "bg-rose-50", slate: "bg-slate-50" },
    lcoeSeg: { capex: ["#0891b2", "#0284c7", "#7c3aed", "#4f46e5", "#9333ea", "#0d9488", "#2563eb"], opex: ["#ea580c", "#d97706", "#db2777", "#ca8a04", "#e11d48", "#a16207"], credit: "#059669" },
    chart: { grid: "#e2e8f0", axis: "#64748b", tipBg: "#ffffff", tipBorder: "#cbd5e1", load: "#0891b2", loadFill: "#a5f3fc", temp: "#d97706", pv: "#7c3aed", bar1: "#0891b2", bar2: "#f59e0b", ref: "#94a3b8", refWarn: "#e11d48", wind: "#0284c7", imp: "#0e7490", bessC: "#7c3aed", engineC: "#ea580c", turbineC: "#db2777", socC: "#64748b", unservedC: "#e11d48" },
  },
};

const ThemeCtx = createContext(THEMES.dark);
const useT = () => useContext(ThemeCtx);

/* Where the value in a control has to come from, so the control can colour itself. */
const SourceCtx = createContext(null);
const useSource = () => useContext(SourceCtx);
const sourceHelp = (src) => (src === "site"
  ? "Specific to your project — the library cannot guess it"
  : "Not project specific — a default that is usually fine, editable if you know better");

/* ============================================================================
   ICONS
   Drawn inline rather than pulled from an icon package: the tool is delivered
   as one file with no build step beyond Vite, and a dependency for thirteen
   glyphs is not worth it. Every path inherits the surrounding text colour.
   ========================================================================== */

const ICON_PATHS = {
  project: <><path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z" /><path d="M13 3v5h5" /><path d="M9 13h6M9 16.5h6" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.4 2.8 2.4 15.2 0 18" /><path d="M12 3c-2.4 2.8-2.4 15.2 0 18" /></>,
  pylon: <><path d="M12 3v18" /><path d="M7 21 12 3l5 18" /><path d="M6.2 9.5h11.6" /><path d="M7.6 14.5h8.8" /><path d="M4 6h4M16 6h4" /></>,
  building: <><path d="M4 21V6.5L12 3l8 3.5V21" /><path d="M3 21h18" /><path d="M10 21v-4.5h4V21" /><path d="M8 9h2M14 9h2M8 12.5h2M14 12.5h2" /></>,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9M18.7 18.7l-1.9-1.9M7.2 7.2 5.3 5.3" /></>,
  coins: <><ellipse cx="12" cy="6.2" rx="7" ry="3.1" /><path d="M5 6.2v5.3c0 1.7 3.1 3.1 7 3.1s7-1.4 7-3.1V6.2" /><path d="M5 11.5v5.3c0 1.7 3.1 3.1 7 3.1s7-1.4 7-3.1v-5.3" /></>,
  network: <><circle cx="12" cy="4.5" r="2" /><circle cx="4.8" cy="19" r="2" /><circle cx="19.2" cy="19" r="2" /><path d="M12 6.5v4.8M12 11.3 6.2 17.6M12 11.3l5.8 6.3" /></>,
  curve: <><path d="M3.5 3.5v17h17" /><path d="M6 16.5c2.2-6.5 3.8 1.5 6-3.5s3.4 3.5 8-6" /></>,
  warning: <><path d="M12 3.5 21.5 20.5H2.5z" /><path d="M12 10v4.5" /><path d="M12 17.6h.01" /></>,
  euro: <><circle cx="12" cy="12" r="9" /><path d="M16 8.4a4.4 4.4 0 0 0-6.9 1.2 5.6 5.6 0 0 0 0 4.8A4.4 4.4 0 0 0 16 15.6" /><path d="M7.4 11h6M7.4 13.4h6" /></>,
  brain: <><path d="M12 6.2a2.6 2.6 0 0 0-4.9-.9 2.5 2.5 0 0 0-1.9 3.6 2.7 2.7 0 0 0 .2 4.5A2.6 2.6 0 0 0 9.4 19a2.6 2.6 0 0 0 2.6-2.2z" /><path d="M12 6.2a2.6 2.6 0 0 1 4.9-.9 2.5 2.5 0 0 1 1.9 3.6 2.7 2.7 0 0 1-.2 4.5A2.6 2.6 0 0 1 14.6 19 2.6 2.6 0 0 1 12 16.8z" /><path d="M12 6.2v10.6" /></>,
  analytics: <><path d="M3.5 20.5h17" /><path d="M6.5 20.5v-6.5M11 20.5V7M15.5 20.5v-9M20 20.5V4.5" /></>,
  solar: <><path d="M4 15.5h16l-2.2-9.5a1 1 0 0 0-1-.8H7.2a1 1 0 0 0-1 .8z" /><path d="M9.2 5.2 8 15.5M14.8 5.2 16 15.5M5.1 10.3h13.8" /><path d="M12 15.5V19M9 19h6" /></>,
  wind: <><path d="M12 21v-8.2" /><path d="M9.6 21h4.8" /><path d="M11.4 11.4 4.2 8.2" /><path d="M12.6 11.4 14.3 3.5" /><path d="M12.8 12.6 19.6 16.4" /><circle cx="12" cy="12" r="1.3" /></>,
  battery: <><rect x="3" y="7.5" width="15.5" height="9" rx="2" /><path d="M21 10.8v2.9" /><path d="M11.6 9.6 8.9 13h3.3l-1 2.4" /></>,
  engine: <><rect x="3.2" y="8.6" width="11.6" height="7" rx="1.4" /><path d="M14.8 10.8h3.1l2.4 2.4v2.4h-5.5" /><path d="M6.2 8.6V6.4h4.2v2.2" /><circle cx="7" cy="17.6" r="1.2" /><circle cx="13.2" cy="17.6" r="1.2" /></>,
  compare: <><path d="M12 3.5v17" /><path d="M4 7.5h6M14 7.5h6" /><path d="M7 7.5 4 14h6zM17 7.5 14 14h6z" /><path d="M4 14a3 3 0 0 0 6 0M14 14a3 3 0 0 0 6 0" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.6h.01" /></>,
};

function Icon({ name, className = "h-4 w-4" }) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg viewBox="0 0 24 24" className={`${className} shrink-0`} fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
  );
}

/* A running indicator. Shown wherever a long search is under way, so the screen
   never looks frozen while 8760 hours are being simulated a few hundred times. */
function Spinner({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} shrink-0 animate-spin`} fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

/* ============================================================================
   UI PRIMITIVES
   Input tiers:
     critical — must be set and checked; carries a rule and a bright label
     advanced — has a defensible default; dimmed, and folded away by default
   ========================================================================== */

function Panel({ title, step, right, children, sub }) {
  const T = useT();
  return (
    <section className={`rounded border ${T.panel}`}>
      <header className={`flex items-center justify-between gap-3 border-b px-3 py-2 ${T.rule} ${T.headBg}`}>
        <div className="flex items-baseline gap-2 min-w-0">
          {step && <span className={`font-mono text-xs shrink-0 ${T.tone.cyan}`}>{step}</span>}
          <h2 className={`text-sm font-semibold truncate ${T.head}`}>{title}</h2>
          {sub && <span className={`text-xs truncate hidden sm:inline ${T.faint}`}>{sub}</span>}
        </div>
        <div className="shrink-0">{right}</div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** A term with an explanation on hover. Dotted underline marks it as explainable. */
function Term({ children, explain }) {
  const T = useT();
  if (!explain) return <>{children}</>;
  return (
    <span title={explain} className={`cursor-help underline decoration-dotted underline-offset-2 ${T.termUnderline}`}>
      {children}
    </span>
  );
}

/**
 * computed = this is a result the tool worked out, not something you set.
 * Editable fields carry the blue rule on the left; computed ones do not.
 */
function Field({ label, unit, children, hint, flag, explain, source, computed, tier = "advanced" }) {
  const T = useT();
  const crit = tier === "critical";
  return (
    <label className={`block border-l-2 pl-2 ${computed ? "border-transparent" : T.critRule}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-xs ${crit ? `font-medium ${T.critLabel}` : T.advLabel}`}>
          <Term explain={explain}>{label}</Term>
        </span>
        <span className={`shrink-0 font-mono text-xs ${T.ghost}`}>{unit}</span>
      </div>
      <SourceCtx.Provider value={source || null}>{children}</SourceCtx.Provider>
      {hint && <div className={`mt-0.5 text-xs ${T.faint}`}>{hint}</div>}
      {flag && <div className={`mt-0.5 font-mono text-xs ${T.tone.amber}`}>{flag}</div>}
    </label>
  );
}

/* Only two states. Yellow: this number is specific to your project and the
   library cannot supply it. Grey text on white: everything else. */
/* Empty yellow fields read as zero in the engine, never as NaN. */
const numz = (v) => {
  if (v === "" || v === null || v === undefined) return 0;
  if (Array.isArray(v)) return v.map(numz);
  if (typeof v === "object") { const o = {}; for (const k in v) o[k] = numz(v[k]); return o; }
  return v;
};

const inpCls = (T, src) => `mt-0.5 w-full rounded border px-2 py-1 font-mono text-sm focus:outline-none ${
  src === "site" ? T.inputSite : T.inputLib}`;

function Num({ value, onChange, step = 1, min, max, disabled }) {
  const T = useT(); const src = useSource();
  return (
    <input type="number" className={inpCls(T, src)} title={sourceHelp(src)} value={value === "" || value === null ? "" : value}
      step={step} min={min} max={max} disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
  );
}

function Txt({ value, onChange, placeholder, readOnly }) {
  const T = useT(); const src = useSource();
  return <input className={inpCls(T, src)} title={sourceHelp(src)} value={value} placeholder={placeholder} readOnly={readOnly}
    onChange={onChange ? (e) => onChange(e.target.value) : undefined} />;
}

function Sel({ value, onChange, options, disabled, prompt }) {
  const T = useT(); const src = useSource();
  const blank = value === "" || value === undefined || value === null;
  return (
    <select className={inpCls(T, src)} title={sourceHelp(src)} value={blank ? "" : value} disabled={disabled}
      onChange={(e) => onChange(e.target.value)}>
      {(blank || prompt) && <option value="">{prompt || "— choose —"}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** A folded group of advanced parameters. Remounted when the global density
 *  switch changes, so "Show every parameter" opens all of them at once. */
function Advanced({ title, count, defaultOpen, children }) {
  const T = useT();
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className={`mt-3 rounded border ${T.tile}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 px-2 py-1.5">
        <span className={`text-xs uppercase tracking-wide ${T.faint}`}>
          <span className="font-mono mr-1">{open ? "−" : "+"}</span>{title}
        </span>
        <span className={`font-mono text-xs ${T.ghost}`}>{count} parameter{count === 1 ? "" : "s"} on default</span>
      </button>
      {open && <div className={`border-t p-2 ${T.rule}`}>{children}</div>}
    </div>
  );
}

function Stat({ label, value, unit, tone = "slate" }) {
  const T = useT();
  return (
    <div className={`rounded border px-2 py-1.5 ${T.tile}`}>
      <div className={`text-xs truncate ${T.faint}`}>{label}</div>
      <div className={`font-mono text-sm ${T.tone[tone]}`}>{value} <span className={`text-xs ${T.ghost}`}>{unit}</span></div>
    </div>
  );
}

/** The derivation trace: every computed number shown as the equation that produced it. */
function Trace({ lines }) {
  const T = useT();
  return (
    <div className={`rounded border ${T.tile}`}>
      <div className={`border-b px-2 py-1 text-xs uppercase tracking-wide ${T.rule} ${T.faint}`}>Calculation detail — input, method, result</div>
      <div className={`divide-y ${T.divide}`}>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-baseline gap-x-2 px-2 py-1">
            <span className={`w-40 shrink-0 text-xs ${T.faint}`}>{l.label}</span>
            <span className={`font-mono text-xs ${T.muted}`}>{l.expr}</span>
            <span className={`ml-auto font-mono text-xs ${T.tone.cyan}`}>{l.result}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Notices({ items }) {
  const T = useT();
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      {items.map((n, i) => (
        <div key={i} className={`rounded border px-2 py-1 text-xs ${T.notice[n.level]}`}>
          <span className="font-mono uppercase mr-2">{n.level === "warn" ? "check" : n.level === "fail" ? "blocker" : "note"}</span>{n.text}
        </div>
      ))}
    </div>
  );
}

function NeedsRunCard({ T, onRun }) {
  return (
    <div className={`rounded border p-4 text-center ${T.tile}`}>
      <div className={`text-sm ${T.title}`}>No dispatch results yet</div>
      <div className={`mt-1 text-xs ${T.faint}`}>
        Define the system in steps 1 to 4, then run the dispatch. Results appear here.
      </div>
      <button onClick={onRun} className={`mt-3 rounded border px-4 py-1.5 text-xs ${T.chip}`}>Run dispatch</button>
    </div>
  );
}

/** Single-line diagram of the design, drawn from the current equipment list. */
function SystemDiagram({ T, res, gridOn, gridCapMW, loadMW, loadLabel, gfSource }) {
  const sources = [];
  if (res.pv.enabled) sources.push({ k: "pv", label: "Solar PV", rating: `${(res.pv.kWp / 1000).toFixed(1)} MWp`, c: T.chart.temp });
  if (res.wind.enabled) sources.push({ k: "wind", label: "Wind", rating: `${(res.wind.ratedKW / 1000).toFixed(1)} MW`, c: T.chart.wind });
  if (res.bess.enabled) sources.push({ k: "bess", label: "Battery", rating: `${(res.bess.powerKW / 1000).toFixed(1)} MW / ${(res.bess.energyKWh / 1000).toFixed(1)} MWh`, c: T.chart.bessC });
  if (res.engine.enabled) sources.push({ k: "engine", label: `${res.engine.units} × generator`, rating: `${(res.engine.units * res.engine.unitKW / 1000).toFixed(1)} MW total`, c: T.chart.engineC });
  if (res.turbine.enabled) sources.push({ k: "turbine", label: "Gas turbine", rating: `${(res.turbine.ratedKW / 1000).toFixed(1)} MW`, c: T.chart.turbineC });

  const W = 900, boxW = 150, gap = 22;
  const totalW = sources.length * boxW + Math.max(0, sources.length - 1) * gap;
  const startX = Math.max(190, (W - totalW) / 2);
  const busY = 210, boxY = 70, boxH = 62;
  const H2 = 340;

  return (
    <svg viewBox={`0 0 ${W} ${H2}`} className="w-full" style={{ maxHeight: 340 }} role="img" aria-label="Single-line diagram">
      {/* Grid supply */}
      {gridOn && (<>
        <rect x="16" y={busY - 34} width="130" height="68" rx="4" fill="none" stroke={T.chart.imp} strokeWidth="1.5" />
        <text x="81" y={busY - 12} textAnchor="middle" fontSize="12" fill={T.chart.imp}>Utility grid</text>
        <text x="81" y={busY + 6} textAnchor="middle" fontSize="11" fill={T.chart.axis}>{gridCapMW.toFixed(1)} MW import</text>
        <text x="81" y={busY + 22} textAnchor="middle" fontSize="10" fill={T.chart.axis}>{gfSource === "grid" ? "sets the frequency" : ""}</text>
        <line x1="146" y1={busY} x2="200" y2={busY} stroke={T.chart.imp} strokeWidth="2" />
        <circle cx="164" cy={busY} r="9" fill="none" stroke={T.chart.imp} strokeWidth="1.5" />
        <circle cx="180" cy={busY} r="9" fill="none" stroke={T.chart.imp} strokeWidth="1.5" />
        <text x="172" y={busY + 26} textAnchor="middle" fontSize="9" fill={T.chart.axis}>transformer</text>
      </>)}
      {!gridOn && (
        <text x="16" y={busY + 4} fontSize="12" fill={T.chart.axis}>No grid connection — island at all times</text>
      )}

      {/* Busbar */}
      <line x1={gridOn ? 200 : 170} y1={busY} x2={W - 30} y2={busY} stroke={T.chart.axis} strokeWidth="4" />
      <text x={W - 30} y={busY - 10} textAnchor="end" fontSize="11" fill={T.chart.axis}>Site main busbar</text>

      {/* Generation and storage */}
      {sources.map((src, i) => {
        const x = startX + i * (boxW + gap);
        const cx = x + boxW / 2;
        return (
          <g key={src.k}>
            <rect x={x} y={boxY} width={boxW} height={boxH} rx="4" fill="none" stroke={src.c} strokeWidth="1.5" />
            <text x={cx} y={boxY + 24} textAnchor="middle" fontSize="12" fill={src.c}>{src.label}</text>
            <text x={cx} y={boxY + 42} textAnchor="middle" fontSize="11" fill={T.chart.axis}>{src.rating}</text>
            {gfSource === src.k && (
              <text x={cx} y={boxY + 56} textAnchor="middle" fontSize="9" fill={T.chart.axis}>sets the frequency</text>
            )}
            <line x1={cx} y1={boxY + boxH} x2={cx} y2={busY} stroke={src.c} strokeWidth="1.5" />
            <circle cx={cx} cy={busY} r="3.5" fill={src.c} />
          </g>
        );
      })}

      {/* Load */}
      <line x1={W / 2} y1={busY} x2={W / 2} y2={busY + 50} stroke={T.chart.load} strokeWidth="2" />
      <rect x={W / 2 - 120} y={busY + 50} width="240" height="58" rx="4" fill="none" stroke={T.chart.load} strokeWidth="1.5" />
      <text x={W / 2} y={busY + 74} textAnchor="middle" fontSize="12" fill={T.chart.load}>{loadLabel}</text>
      <text x={W / 2} y={busY + 94} textAnchor="middle" fontSize="11" fill={T.chart.axis}>{loadMW.toFixed(2)} MW peak</text>
    </svg>
  );
}

function Badge({ v }) {
  const T = useT();
  const cls = v === "PASS" ? T.chipOk : v === "MARGINAL" ? T.chipWarn : T.notice.fail;
  return <span className={`rounded border px-2 py-0.5 font-mono text-xs ${cls}`}>{v}</span>;
}

function Seg({ value, onChange, options }) {
  const T = useT();
  return (
    <div className={`flex overflow-hidden rounded border ${T.btn}`}>
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} title={o.title || undefined}
          className={`whitespace-nowrap px-2 py-1 text-xs ${value === o.value ? T.btnOn : ""}`}>{o.label}</button>
      ))}
    </div>
  );
}

/* Countries represented in the site library, for the country selector. */
export const COUNTRY_NAMES = {
  FR: "France", NL: "Netherlands", DE: "Germany", UK: "United Kingdom", ES: "Spain",
  SA: "Saudi Arabia", AE: "United Arab Emirates", CL: "Chile", SG: "Singapore",
  XX: "Off-grid / island reference", OTHER: "Other — not listed",
};
export const COUNTRY_OPTIONS = Array.from(new Set(Object.values(LOCATION_LIBRARY).map((v) => v.country)))
  .map((c) => ({ value: c, label: COUNTRY_NAMES[c] || c }));

export const TABS = [
  { n: 1,  title: "Project",     icon: "project",    sub: "project file and conventions" },
  { n: 2,  title: "Location",    icon: "globe",      sub: "site, climate and renewable resource" },
  { n: 3,  title: "Connection",  icon: "pylon",      sub: "connection capacity and terms" },
  { n: 4,  title: "Load",        icon: "building",   sub: "hourly demand profile" },
  { n: 5,  title: "Equipment",   icon: "gear",       sub: "installed generation and storage" },
  { n: 6,  title: "Costs",       icon: "coins",      sub: "electricity, equipment and fuel prices" },
  { n: 7,  title: "Microgrid",   icon: "network",    sub: "objectives and dispatch logic" },
  { n: 8,  title: "Dispatch",    icon: "curve",      sub: "hourly operation of every asset" },
  { n: 9,  title: "Reliability", icon: "warning",    sub: "adequacy assessment and checks" },
  { n: 10, title: "LCOE",        icon: "euro",       sub: "levelised cost and its components" },
  { n: 11, title: "Auto-size",   icon: "brain",      sub: "ranked search for a lower-cost compliant design" },
  { n: 12, title: "Report",      icon: "analytics",  sub: "requirement, solution and performance" },
  { n: 13, title: "Compare",     icon: "compare",    sub: "side-by-side design comparison" },
];

/* showName controls only the small caption in front of the group. The last two
   groups drop it so the whole banner fits the page without a scroller; their
   colour still identifies them. */
export const TAB_STAGES = [
  { name: "Define", from: 0, to: 6, showName: true },
  { name: "Analyse", from: 7, to: 9, showName: true },
  { name: "Optimise", from: 10, to: 10, showName: false },
  { name: "Report", from: 11, to: 12, showName: false },
];

export const SCENARIO_ROWS = [
  { k: "pvMWp", label: "PV (MWp)", d: 2 }, { k: "bessMW", label: "BESS power (MW)", d: 2 },
  { k: "bessMWh", label: "BESS energy (MWh)", d: 1 }, { k: "engines", label: "Engine units", d: 0 },
  { k: "importCapMW", label: "Import cap (MW)", d: 1 }, { k: "reserveSoc", label: "Reserve SOC (%)", d: 0 },
  { k: "yield", label: "Specific yield (kWh/kWp)", d: 0 }, { k: "discount", label: "Discount rate (%)", d: 1 },
  { k: "lcoe", label: "LCOE (€/MWh)", d: 1 }, { k: "capexM", label: "Capex (M€)", d: 2 },
  { k: "renewablePct", label: "Renewable fraction (%)", d: 1 }, { k: "fuel", label: "Fuel (kl or MWh th)", d: 0 },
  { k: "emissions", label: "Emissions (tCO₂/yr)", d: 0 }, { k: "unservedMWh", label: "Unserved (MWh/yr)", d: 2 },
  { k: "energy", label: "Energy adequacy", d: 0 }, { k: "power", label: "Power adequacy", d: 0 },
  { k: "dynamic", label: "Dynamic adequacy", d: 0 }, { k: "npvM", label: "NPV (M€)", d: 2 },
];

/* Cost library fields — label, unit and step for the editable defaults table. */
export const COST_FIELDS = [
  { k: "PV_EUR_PER_KWP", label: "PV, installed", unit: "€/kWp", step: 10 },
  { k: "WIND_EUR_PER_KW", label: "Wind, installed", unit: "€/kW", step: 10 },
  { k: "BESS_EUR_PER_KW", label: "BESS power conversion", unit: "€/kW", step: 5 },
  { k: "BESS_EUR_PER_KWH", label: "BESS energy", unit: "€/kWh", step: 5 },
  { k: "BESS_GRID_FORMING_ADDER_EUR_PER_KW", label: "Grid-forming adder", unit: "€/kW", step: 5 },
  { k: "ENGINE_DIESEL_EUR_PER_KW", label: "Diesel engines", unit: "€/kW", step: 10 },
  { k: "ENGINE_GAS_EUR_PER_KW", label: "Gas engines", unit: "€/kW", step: 10 },
  { k: "TURBINE_EUR_PER_KW", label: "Gas turbine", unit: "€/kW", step: 10 },
  { k: "GRID_CONNECTION_EUR_PER_KW", label: "Grid connection charge", unit: "€/kW", step: 5 },
  { k: "BOP_EUR_PER_MWP_PV", label: "BOP — PV", unit: "€/MWp", step: 1000 },
  { k: "BOP_EUR_PER_MW_BESS", label: "BOP — BESS power", unit: "€/MW", step: 1000 },
  { k: "BOP_EUR_PER_MWH_BESS", label: "BOP — BESS energy", unit: "€/MWh", step: 500 },
  { k: "BOP_EUR_PER_MW_THERMAL", label: "BOP — thermal plant", unit: "€/MW", step: 1000 },
  { k: "BOP_EUR_PER_MW_SWITCHGEAR", label: "BOP — MV switchgear", unit: "€/MW", step: 1000 },
  { k: "BOP_FIXED_EUR", label: "BOP — site establishment", unit: "€", step: 10000 },
  { k: "OM_PV_EUR_PER_KWP_YR", label: "O&M PV", unit: "€/kWp/yr", step: 1 },
  { k: "OM_WIND_EUR_PER_KW_YR", label: "O&M wind", unit: "€/kW/yr", step: 1 },
  { k: "OM_BESS_PCT_CAPEX_YR", label: "O&M BESS", unit: "% capex/yr", step: 0.1 },
  { k: "OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW", label: "O&M engines", unit: "€/MW/run h", step: 0.5 },
  { k: "BESS_AUGMENTATION_EUR_PER_KWH", label: "Augmentation cost", unit: "€/kWh", step: 5 },
  { k: "AUGMENTATION_YEARS", label: "Augmentation year(s)", unit: "comma-separated" },
  { k: "EXPORT_PRICE_EUR_PER_MWH", label: "Export value", unit: "€/MWh", step: 5 },
];

function DetailToggle({ value, onChange }) {
  return <Seg value={value} onChange={onChange}
    options={[{ value: "summary", label: "Summary" }, { value: "detail", label: "Detailed" }]} />;
}

const PHASES = [
  { n: 1, label: "Context · resource · load", done: true },
  { n: 2, label: "Resources · dispatch engine", done: true },
  { n: 3, label: "Adequacy · BOM", done: true },
  { n: 4, label: "Costs · LCOE", done: true },
  { n: 5, label: "Auto-size · AIDC ramp", done: true },
  { n: 6, label: "Financials · scenarios · Excel", done: true },
];

/* ============================================================================
   APP
   ========================================================================== */

export default function MicrogridDesignTool() {
  const cal = useMemo(() => buildCalendar(), []);
  const fileRef = useRef(null);
  const resFileRef = useRef(null);

  const [themeKey, setThemeKey] = useState("light");
  const T = THEMES[themeKey];
  const [density, setDensity] = useState("essential"); // "essential" | "full"
  const showAll = density === "full";

  const [mode, setMode] = useState("aidc"); // "standard" | "aidc"

  const [ctx, setCtx] = useState({
    useCase: "", gridStatus: "", importCapKW: "", exportCapKW: 0,
    flexPctHours: 20, flexReducedCapKW: 4000,
    phases: [{ year: 1, capKW: "" }],
    islanding: "planned", autonomyH: 4, locationId: "FR_PARIS", lifeYears: 20, discountPct: 7,
  });

  const [locOverride, setLocOverride] = useState({});
  const [resourceSource, setResourceSource] = useState({ pv: "library", temp: "library", note: null });
  const [uploadedResource, setUploadedResource] = useState(null);

  const [aidc, setAidc] = useState({
    targetMWIT: "",
    ramp: [{ year: 1, mwIT: "" }],
    analysisYear: 1,
    coolingType: "", designPUE: "",
    freeCoolingBelowC: CONSTANTS.COOLING.liquid.freeCoolingBelowC,
    designAmbientC: CONSTANTS.COOLING.air.designAmbientC,
    itUtilisationPct: CONSTANTS.IT_UTILISATION_PCT_DEFAULT,
    redundancy: "", topology: "",
    upsPresent: true, upsAutonomyMin: 5,
    loadSwingPct: "",
    loadSwingSeconds: CONSTANTS.LOAD_SWING_SECONDS_DEFAULT,
    antiRecycleMin: CONSTANTS.ANTI_RECYCLE_TIMER_MIN_DEFAULT,
    landPV_ha: "", pvAreaPerKWp: CONSTANTS.PV_AREA_M2_PER_KWP,
    landBESS_m2: "", bessFootprint: CONSTANTS.BESS_FOOTPRINT_M2_PER_MW,
    landEngine_m2: "", engineFootprint: CONSTANTS.ENGINE_FOOTPRINT_M2_PER_MW,
    gridStrategy: "", engineHoursLimit: "", noiseLimitNote: "", waterAvailable: false,
    pueTouched: false,
  });

  const [loadCfg, setLoadCfg] = useState({
    path: "parametric", annualEnergyMWh: "", peakKW: "", baseKW: "",
    shapeKey: "", seasonality: 12, seasonalPeak: "winter", weekendFactor: 1.0,
    customWeekday: [...LOAD_SHAPES.custom.weekday], customWeekend: [...LOAD_SHAPES.custom.weekend],
  });
  const [csvResult, setCsvResult] = useState(null);

  const [char, setChar] = useState({
    critPct: "", shed1Pct: 10, shed2Pct: 5,
    stepKW: "", motorKW: "", motorMethod: "",
    parasiticMode: "pct", parasiticPct: 5, parasiticKW: 0, touched: false,
  });

  const [view, setView] = useState({ span: "week", startDay: 172 });
  const [reasonFilter, setReasonFilter] = useState(-1);
  /* The method note is a page in its own right, not a fourteenth step. It is
     reached from the footer, and while it is open `tab` reads -1 so every
     `tab === n` gate below closes on its own and nothing else has to change.
     The tab band keeps its thirteen buttons and their data-mgt-tab attributes. */
  const [tabSel, setTabSel] = useState(0);
  const [showInfo, setShowInfo] = useState(false);
  const tab = showInfo ? -1 : tabSel;
  const setTab = (v) => { setShowInfo(false); setTabSel(v); };
  const [noticesOpen, setNoticesOpen] = useState(true);
  const [selfTestOpen, setSelfTestOpen] = useState(false);
  const [logicApplied, setLogicApplied] = useState(false);
  const [justRan, setJustRan] = useState(false);
  const [detail, setDetail] = useState({ dispatch: "summary", reliability: "summary", report: "summary" });
  const [lastImported, setLastImported] = useState(null);
  const [autoRun, setAutoRun] = useState(false);
  const [lcoeBoundary, setLcoeBoundary] = useState("facility");
  const [costs, setCosts] = useState({ ...CONSTANTS.COST_DEFAULTS });
  const [fin, setFin] = useState({ enabled: false, gearingPct: 70, tenorYears: 12, interestPct: 5.5, creditBaselineCapex: false });
  const [sweep, setSweep] = useState({ mode: "guided",
    // guided overrides — blank means "use the proposed value"
    gPvOn: null, gWindOn: null, gBessOn: null, gEngineOn: null,
    gPvMaxMWp: "", gWindMaxMW: "", gBessMaxMW: "", gEngineUnitKW: "",
    // generator fuel searched: "project" follows the Equipment tab, or force one
    gEngineFuel: "project",
    // manual ranges
    includePV: true, includeBess: true, includeWind: false, includeEngine: false,
    pvMin: 0, pvMax: 20, pvSteps: 5, bessMin: 0, bessMax: 12, bessSteps: 4, durations: "2, 4",
    windMin: 0, windMax: 20, windSteps: 3, engineUnitKW: "", engineUnits: "0, 2, 4, 6" });
  const [sweepOut, setSweepOut] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepPct, setSweepPct] = useState(0);
  const [sweepStartedAt, setSweepStartedAt] = useState(0);
  const [sweepElapsedS, setSweepElapsedS] = useState(0);
  const [scenarios, setScenarios] = useState([]);
  const [scenarioName, setScenarioName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectNotes, setProjectNotes] = useState("");
  const [uploadedPrice, setUploadedPrice] = useState(null);
  const [priceNote, setPriceNote] = useState(null);
  const priceFileRef = useRef(null);
  const [configMsgs, setConfigMsgs] = useState(null);
  const cfgFileRef = useRef(null);

  const [res, setRes] = useState({
    pv: { enabled: false, kWp: "", dcacRatio: CONSTANTS.PV_DCAC_RATIO_DEFAULT, soilingPct: CONSTANTS.PV_SOILING_PCT,
      bifacialGainPct: CONSTANTS.PV_BIFACIAL_GAIN_PCT, availabilityPct: CONSTANTS.PV_AVAILABILITY_PCT,
      otherLossesPct: CONSTANTS.PV_OTHER_LOSSES_PCT, degradationPctPerYr: CONSTANTS.PV_DEGRADATION_PCT_PER_YR },
    wind: { enabled: false, ratedKW: "", hubHeightM: 100, cutInMs: CONSTANTS.WIND_CUT_IN_M_S, ratedMs: CONSTANTS.WIND_RATED_M_S,
      cutOutMs: CONSTANTS.WIND_CUT_OUT_M_S, availabilityPct: CONSTANTS.WIND_AVAILABILITY_PCT },
    bess: { enabled: false, powerKW: "", energyKWh: "", cRate: CONSTANTS.BESS_C_RATE, rtePct: CONSTANTS.BESS_RTE_PCT,
      socMinPct: CONSTANTS.BESS_SOC_MIN_PCT, socMaxPct: CONSTANTS.BESS_SOC_MAX_PCT, reserveSocPct: CONSTANTS.BESS_RESERVE_SOC_PCT,
      startSocPct: 60, gridForming: true, gridFormingStepPct: CONSTANTS.BESS_GRID_FORMING_STEP_PCT, arbitrage: true },
    engine: { enabled: false, units: "", unitKW: "", fuelType: "", minStableLoadPct: CONSTANTS.ENGINE_MIN_STABLE_LOAD_PCT,
      stepAcceptancePct: CONSTANTS.ENGINE_STEP_ACCEPTANCE_PCT, startTimeMin: CONSTANTS.ENGINE_START_TIME_MIN_GAS,
      minUpTimeH: CONSTANTS.ENGINE_MIN_UP_TIME_H, minDownTimeH: CONSTANTS.ENGINE_MIN_DOWN_TIME_H, annualHourLimit: 500,
      economicRun: false },
    turbine: { enabled: false, ratedKW: "", minLoadPct: CONSTANTS.TURBINE_MIN_LOAD_PCT,
      minUpTimeH: CONSTANTS.TURBINE_MIN_UP_TIME_H, minDownTimeH: CONSTANTS.TURBINE_MIN_DOWN_TIME_H },
    tariff: { structure: "", peakStartHour: CONSTANTS.TOU_PEAK_START_HOUR, peakEndHour: CONSTANTS.TOU_PEAK_END_HOUR,
      peakMultiplier: CONSTANTS.TOU_PEAK_MULTIPLIER, offPeakMultiplier: CONSTANTS.TOU_OFFPEAK_MULTIPLIER },
    shave: { enabled: false, targetKW: 0 },
    lookahead: { enabled: true, horizonH: CONSTANTS.LOOKAHEAD_HOURS },
    optSocLevels: CONSTANTS.OPT_SOC_LEVELS, optWearCost: CONSTANTS.BESS_WEAR_COST_EUR_PER_MWH,
    meritOrder: "", dispatchMode: "",
  });

  // The land limit applies in every mode, not only the data-centre path
  const maxPVfromLandKWp = numz(aidc.landPV_ha) > 0
    ? (numz(aidc.landPV_ha) * CONSTANTS.M2_PER_HA) / (numz(aidc.pvAreaPerKWp) || CONSTANTS.PV_AREA_M2_PER_KWP) : 0;

  /* --- Sanitised copies: blank yellow fields read as zero in the engine ---- */
  const resN = useMemo(() => numz(res), [res]);
  const ctxN = useMemo(() => numz(ctx), [ctx]);
  const charN = useMemo(() => numz(char), [char]);
  const aidcN = useMemo(() => numz(aidc), [aidc]);

  const simYear = mode === "aidc" ? aidc.analysisYear : 1;

  const effectiveImportCapKW = useMemo(() => {
    if (ctx.gridStatus !== "phased" || !ctx.phases.length) return ctx.importCapKW;
    const sorted = [...ctx.phases].sort((a, b) => a.year - b.year);
    let cap = sorted[0].capKW;
    for (const p of sorted) if (simYear >= p.year) cap = p.capKW;
    return cap;
  }, [ctx.gridStatus, ctx.phases, ctx.importCapKW, simYear]);

  /* --- Derived ------------------------------------------------------------ */
  // Until a site is chosen the tool falls back to the blank custom entry, so
// every downstream calculation has numbers to work with rather than undefined.
  const loc = useMemo(() => ({ ...(LOCATION_LIBRARY[ctx.locationId] || LOCATION_LIBRARY.CUSTOM_SITE), ...locOverride }),
    [ctx.locationId, locOverride]);
  const temp = useMemo(() => uploadedResource?.temp || buildTemperature(loc, cal), [loc, cal, uploadedResource]);
  const pvUnit = useMemo(() => uploadedResource?.pvUnit || buildPVUnit(loc, cal, temp), [loc, cal, temp, uploadedResource]);
  const annualMeanT = useMemo(() => { let s = 0; for (let i = 0; i < H; i++) s += temp[i]; return s / H; }, [temp]);

  const aidcYearMW = useMemo(() => {
    const r = aidc.ramp.find((x) => x.year === aidc.analysisYear);
    return r ? r.mwIT : aidc.targetMWIT;
  }, [aidc]);

  const aidcDerived = useMemo(() => (mode === "aidc" ? deriveAIDCLoad(aidcN, temp, numz(aidcYearMW)) : null), [mode, aidcN, temp, aidcYearMW]);
  const synth = useMemo(() => (mode === "standard" && loadCfg.path === "parametric" ? synthesiseLoad({ ...numz(loadCfg), cal }) : null), [mode, loadCfg, cal]);

  const load = useMemo(() => {
    if (mode === "aidc") return aidcDerived.load;
    if (loadCfg.path === "csv" && csvResult?.load) return csvResult.load;
    return synth ? synth.load : new Float32Array(H);
  }, [mode, aidcDerived, loadCfg.path, csvResult, synth]);

  const stats = useMemo(() => loadStats(load, cal), [load, cal]);
  const ldc = useMemo(() => durationCurve(load), [load]);

  const loadSource = useMemo(() => {
    if (mode === "aidc") return { kind: "Calculated from IT capacity", text: `Data-centre model · year ${aidc.analysisYear} · ${fmt(aidcYearMW, 1)} MW IT · annualised PUE ${fmt(aidcDerived.annualisedPUE, 3)}` };
    if (loadCfg.path === "csv" && csvResult?.load) return { kind: "From your uploaded file", text: `Uploaded CSV · ${csvResult.rowsIn} rows · ${csvResult.detected} → 8760 h` };
    if (loadCfg.path === "csv") return { kind: "No file loaded", text: "No CSV loaded yet — upload a file or switch to parametric synthesis" };
    return { kind: "Built from your figures", text: `Typical profile · ${(LOAD_SHAPES[loadCfg.shapeKey] || { label: "no shape chosen" }).label} · shape exponent γ = ${fmt(synth?.gamma, 3)}` };
  }, [mode, loadCfg, csvResult, synth, aidc.analysisYear, aidcYearMW, aidcDerived]);

  const aidcOut = useMemo(() => {
    if (mode !== "aidc" || !aidcDerived) return null;
    const red = CONSTANTS.REDUNDANCY[aidc.redundancy] || CONSTANTS.REDUNDANCY.N;
    const peakMW = stats.peakKW / 1000;
    const designPeakMW = aidcDerived.designConditionKW / 1000;
    const sizingBasisMW = Math.max(peakMW, designPeakMW);
    const firmMW = sizingBasisMW * red.firmFactor;
    const stepKW = aidcDerived.itKW * (aidc.loadSwingPct / 100);
    const maxKWp = (aidc.landPV_ha * CONSTANTS.M2_PER_HA) / aidc.pvAreaPerKWp;
    const maxBessMW = aidc.landBESS_m2 / aidc.bessFootprint;
    const maxEngineMW = aidc.landEngine_m2 / aidc.engineFootprint;
    const critPct = 100 * (aidcDerived.itKW + aidcDerived.coolingDesignKW * 0.6) / (stats.meanKW || 1);
    return { red, peakMW, designPeakMW, sizingBasisMW, firmMW, stepKW, maxKWp, maxBessMW, maxEngineMW, critPct: Math.min(99, critPct) };
  }, [mode, aidc, aidcDerived, stats]);

  const notices = useMemo(() => {
    const n = [];
    const blanks = [];
    if (mode === "standard" && loadCfg.path === "parametric") {
      if (!loadCfg.annualEnergyMWh) blanks.push("annual energy");
      if (!loadCfg.peakKW) blanks.push("peak demand");
    }
    if (mode === "aidc" && !aidc.targetMWIT) blanks.push("target IT capacity");
    if (ctx.gridStatus !== "none" && !effectiveImportCapKW) blanks.push("grid import cap");
    if (!res.pv.enabled && !res.bess.enabled && !res.engine.enabled && !res.wind.enabled && !res.turbine.enabled) {
      blanks.push("at least one piece of equipment");
    }
    if (blanks.length) {
      n.push({ level: "warn", text: `Still to fill in before the results mean anything: ${blanks.join(", ")}. Empty yellow fields are read as zero, so the run will complete but the numbers will be meaningless.` });
    }
    if (ctx.gridStatus !== "none" && ctx.gridStatus !== "" && effectiveImportCapKW > 0 && stats.peakKW > effectiveImportCapKW * 1.02) {
      n.push({ level: "warn", text: `The connection is ${fmt(effectiveImportCapKW / 1000, 1)} MW but the site peaks at ${fmt(stats.peakKW / 1000, 1)} MW, so the grid alone cannot serve this load. The financial model still compares against buying everything from the grid, which is not an available option here — read the NPV and IRR as indicative only, and judge the project on capacity delivered and time-to-power instead.` });
    }
    if (maxPVfromLandKWp > 0 && res.pv.enabled && numz(res.pv.kWp) > maxPVfromLandKWp) {
      n.push({ level: "warn", text: `PV is set to ${fmt(numz(res.pv.kWp) / 1000, 2)} MWp but the ${fmt(numz(aidc.landPV_ha), 1)} ha available only fits ${fmt(maxPVfromLandKWp / 1000, 2)} MWp at ${fmt(numz(aidc.pvAreaPerKWp) || CONSTANTS.PV_AREA_M2_PER_KWP, 1)} m²/kWp. Either the array will not fit or the land figure is wrong.` });
    }
    if (ctx.locationId === "CUSTOM_SITE") {
      n.push({ level: "warn", text: `Custom site: the solar yield (${fmt(loc.specificYield_kWh_per_kWp, 0)} kWh/kWp), monthly shape, temperatures and wind speed are generic placeholders, not data for your location. Get the yield and the monthly profile from PVGIS for the real coordinates, or upload an hourly file, before quoting any LCOE.` });
    }
    if (resourceSource.pv === "library") {
      n.push({ level: "warn", text: `Specific yield ${fmt(loc.specificYield_kWh_per_kWp, 0)} kWh/kWp is a library default for ${loc.label}, not site data. Uncertainty band ±${CONSTANTS.LIBRARY_YIELD_UNCERTAINTY_PCT}%. Two bidders' LCOEs usually differ because their yield assumptions differ, not their equipment.` });
    }
    if (mode === "standard") {
      const sum = char.critPct + char.shed1Pct + char.shed2Pct;
      if (Math.abs(sum - 100) > 0.5) n.push({ level: "warn", text: `Criticality split sums to ${fmt(sum, 1)} %, not 100 %.` });
      if (synth?.clamped === "low") n.push({ level: "warn", text: `Annual energy ${fmt(loadCfg.annualEnergyMWh, 0)} MWh is below what this shape can produce with a ${fmt(loadCfg.baseKW, 0)} kW base load (minimum ≈ ${fmt(synth.feasibleMWh[0], 0)} MWh). Reduce the base load or raise the annual energy.` });
      if (synth?.clamped === "high") n.push({ level: "warn", text: `Annual energy ${fmt(loadCfg.annualEnergyMWh, 0)} MWh exceeds what a ${fmt(loadCfg.peakKW, 0)} kW peak can deliver on this shape (maximum ≈ ${fmt(synth.feasibleMWh[1], 0)} MWh). Raise the peak or lower the annual energy.` });
      if (loadCfg.baseKW >= loadCfg.peakKW) n.push({ level: "warn", text: "Base load is at or above peak demand — the profile will be flat." });
      if (char.stepKW > stats.peakKW * 0.5) n.push({ level: "warn", text: `Largest load step ${fmt(char.stepKW, 0)} kW is over half the site peak. Expect the dynamic adequacy check to govern the design.` });
    }
    if (mode === "aidc" && aidcOut) {
      const yr1 = aidc.ramp[0];
      if (yr1 && aidc.targetMWIT > 0 && yr1.mwIT / aidc.targetMWIT < 0.4) {
        n.push({ level: "warn", text: `Day-one load is ${fmt(100 * yr1.mwIT / aidc.targetMWIT, 0)} % of design. Any thermal plant sized for ${fmt(aidc.targetMWIT, 0)} MW IT will sit below minimum stable load in year ${yr1.year} — the phased build-out check in Phase 5 will confirm this.` });
      }
      if (aidc.coolingType !== "air") {
        n.push({ level: "info", text: `Liquid-cooled racks have ~${CONSTANTS.LIQUID_RACK_THERMAL_MARGIN_S} s of thermal margin with no coolant flow, against ~${CONSTANTS.AIR_RACK_THERMAL_MARGIN_S} s for an air-cooled hall. Cooling is not a sheddable load and the UPS does not back it unless it is explicitly on UPS.` });
      }
      if (aidc.redundancy === "TWON" && /single/i.test(aidc.topology)) {
        n.push({ level: "warn", text: "2N declared but the topology description mentions a single shared element. A single EMS, controller or storage system sitting across both paths defeats the redundancy. Full check in Phase 5." });
      }
      if (aidcDerived.aboveDesignHours > 0) {
        n.push({ level: "warn", text: `${aidcDerived.aboveDesignHours} h/yr above the ${fmt(aidc.designAmbientC, 0)} °C design ambient. Cooling power is extrapolated to a maximum of ${fmt((CONSTANTS.COOLING[aidc.coolingType] || CONSTANTS.COOLING.air).overloadCap * 100, 0)} % of design in those hours.` });
      }
      if (aidcOut.designPeakMW > aidcOut.peakMW * 1.02) {
        n.push({ level: "info", text: `Firm capacity is sized on the ${fmt(aidcOut.designPeakMW, 2)} MW design-ambient load, not the ${fmt(aidcOut.peakMW, 2)} MW peak of the typical year. A typical year never reaches the design ambient at this site — sizing on it would undersize the plant.` });
      }
      if (aidc.gridStrategy === "capped" && ctx.importCapKW < stats.peakKW) {
        n.push({ level: "info", text: `Import cap ${fmt(ctx.importCapKW / 1000, 1)} MW is below the ${fmt(stats.peakKW / 1000, 1)} MW facility peak. On-site generation must cover ${fmt((stats.peakKW - ctx.importCapKW) / 1000, 1)} MW at coincident peak.` });
      }
    }
    return n;
  }, [resourceSource, loc, mode, char, synth, loadCfg, stats, aidc, aidcOut, aidcDerived, ctx.importCapKW]);

  const series = useMemo(() => {
    const out = [];
    if (view.span === "year") {
      for (let d = 0; d < 365; d++) {
        let s = 0, t = 0, pv = 0;
        for (let h = 0; h < 24; h++) { const i = d * 24 + h; s += load[i]; t += temp[i]; pv += pvUnit[i]; }
        out.push({ t: dayLabel(d), load: +(s / 24).toFixed(1), temp: +(t / 24).toFixed(1), pv: +pv.toFixed(2) });
      }
      return out;
    }
    const days = view.span === "day" ? 1 : view.span === "week" ? 7 : 30;
    const start = view.startDay * 24;
    for (let k = 0; k < days * 24; k++) {
      const i = (start + k) % H;
      out.push({
        t: days === 1 ? `${String(cal.hourOfDay[i]).padStart(2, "0")}:00` : `${dayLabel(cal.doy[i])} ${String(cal.hourOfDay[i]).padStart(2, "0")}h`,
        load: +load[i].toFixed(1), temp: +temp[i].toFixed(1), pv: +pvUnit[i].toFixed(3),
      });
    }
    return out;
  }, [view, load, temp, pvUnit, cal]);

  /* --- Phase 2: generation profiles ------------------------------------- */
  const pvOut = useMemo(() => (res.pv.enabled ? buildPVGen(pvUnit, res.pv, simYear)
    : { gen: new Float32Array(H), clippedHours: 0, acLimitKW: 0 }), [pvUnit, res.pv, simYear]);
  // Built regardless of whether a wind farm is installed: the national price model
  // needs a wind output series for this site's weather.
  const windSpeed = useMemo(() => buildWindSpeed(loc, cal, res.wind.enabled ? res.wind.hubHeightM : CONSTANTS.WIND_REFERENCE_HEIGHT_M),
    [loc, cal, res.wind.enabled, res.wind.hubHeightM]);
  const nationalWindProfile = useMemo(() => buildWindGen(windSpeed, temp, {
    ratedKW: 1000, cutInMs: CONSTANTS.WIND_CUT_IN_M_S, ratedMs: CONSTANTS.WIND_RATED_M_S,
    cutOutMs: CONSTANTS.WIND_CUT_OUT_M_S, availabilityPct: 100,
  }), [windSpeed, temp]);
  const windGen = useMemo(() => (res.wind.enabled ? buildWindGen(windSpeed, temp, res.wind) : new Float32Array(H)), [windSpeed, temp, res.wind]);
  const windMeanHub = useMemo(() => { if (!windSpeed) return 0; let s2 = 0; for (let i = 0; i < H; i++) s2 += windSpeed[i]; return s2 / H; }, [windSpeed]);
  const windCF = useMemo(() => { if (!res.wind.enabled || !res.wind.ratedKW) return 0; let s2 = 0; for (let i = 0; i < H; i++) s2 += windGen[i]; return s2 / (res.wind.ratedKW * H); }, [windGen, res.wind]);
  const price = useMemo(() => buildTariff(loc, cal, res.tariff, uploadedPrice, pvUnit, nationalWindProfile),
    [loc, cal, res.tariff, uploadedPrice, pvUnit, nationalWindProfile]);
  const priceStats = useMemo(() => {
    let sum = 0, lo = Infinity, hi = -Infinity;
    const monthly = new Float64Array(12), count = new Float64Array(12);
    for (let i = 0; i < H; i++) {
      sum += price[i]; if (price[i] < lo) lo = price[i]; if (price[i] > hi) hi = price[i];
      monthly[cal.month[i]] += price[i]; count[cal.month[i]]++;
    }
    return { mean: sum / H, lo, hi, monthly: Array.from(monthly, (v, i) => ({ m: MONTHS[i], price: +(v / count[i]).toFixed(1) })) };
  }, [price, cal]);

  // Non-firm connections: the worst-case reading is that curtailment lands on the
  // highest-load hours of the year, so those are the hours flagged.
  const curtailFlags = useMemo(() => {
    const f = new Uint8Array(H);
    if (ctx.gridStatus !== "flexible" || !ctx.flexPctHours) return f;
    const idx = Array.from(load.keys()).sort((a, b) => load[b] - load[a]);
    const n = Math.round(H * ctx.flexPctHours / 100);
    for (let i = 0; i < n; i++) f[idx[i]] = 1;
    return f;
  }, [ctx.gridStatus, ctx.flexPctHours, load]);

  const reserveApplies = ctx.islanding !== "none" && ctx.islanding !== "" && ctx.gridStatus !== "none";
  const parasiticKWval = char.parasiticMode === "pct" ? stats.meanKW * char.parasiticPct / 100 : char.parasiticKW;

  // A phased connection steps up over time. The cap in force is the last step
  // whose year has been reached — using the base cap in every year would
  // misreport exactly the ramp the AIDC case is about.

  const gridForBom = {
    enabled: ctx.gridStatus !== "none" && ctx.gridStatus !== "" && !(mode === "aidc" && aidc.gridStrategy === "offgrid"),
    // A non-firm connection contributes only its curtailed capacity as firm.
    firmCapKW: ctx.gridStatus === "flexible" ? ctx.flexReducedCapKW : effectiveImportCapKW,
  };

  /* --- The run gate ------------------------------------------------------
     The dispatch is a deterministic rule-based simulation, not an optimisation,
     and it takes about 5 ms. It is gated behind an explicit run so that the
     results on screen always correspond to a known set of inputs, and so that
     the same pipeline can be reused by the auto-size sweep. Anything cheap and
     downstream of the dispatch — costs, financials, sensitivity — updates live. */
  const dispatchInputs = useMemo(() => ({
    load, pvGen: pvOut.gen, windGen, price, temp, cal,
    shed1Pct: charN.shed1Pct, shed2Pct: charN.shed2Pct,
    grid: {
      enabled: ctx.gridStatus !== "none" && ctx.gridStatus !== "" && !(mode === "aidc" && aidc.gridStrategy === "offgrid"),
      importCapKW: effectiveImportCapKW, exportCapKW: ctx.exportCapKW,
      nonFirm: ctx.gridStatus === "flexible", reducedCapKW: ctx.flexReducedCapKW, curtailFlags,
      shaveEnabled: resN.shave.enabled, shaveTargetKW: resN.shave.targetKW,
    },
    bess: { ...resN.bess, rteFraction: resN.bess.rtePct / 100, reserveApplies },
    engine: { ...resN.engine, sfcDiesel: CONSTANTS.DIESEL_SFC_L_PER_KWH, effGas: CONSTANTS.GAS_ENGINE_EFF_PCT,
      omEURperRunHourPerMW: numz(costs.OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW) },
    turbine: { ...resN.turbine, effCurve: CONSTANTS.TURBINE_EFF_PCT },
    lookahead: resN.lookahead,
    meritOrder: res.meritOrder,
    // Prices the optimiser needs. These were read by optimiseDispatch and
    // optimiseWithDemandCharge but never supplied, so the optimiser priced
    // engine fuel and export revenue at zero — a real distortion on any
    // optimised project with engines or an export route.
    dieselPrice: numz(loc.diesel_EUR_per_litre),
    gasPrice: numz(loc.gas_EUR_per_MWh_th),
    exportPrice: numz(costs.EXPORT_PRICE_EUR_PER_MWH),
    // Settings the optimiser reads. socLevels was offered on the Microgrid tab
    // but never supplied, so the search always ran at the library default
    // whatever the field said. It is clamped again inside optimiseDispatch.
    optimiser: { socLevels: numz(res.optSocLevels) || CONSTANTS.OPT_SOC_LEVELS },
  }), [load, pvOut, windGen, price, temp, cal, char.shed1Pct, char.shed2Pct, ctx, mode, aidc.gridStrategy,
       curtailFlags, res, reserveApplies, effectiveImportCapKW,
       loc.diesel_EUR_per_litre, loc.gas_EUR_per_MWh_th, costs.EXPORT_PRICE_EUR_PER_MWH,
       costs.OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW]);

  // Anything that can change a result belongs here, or the screen can show
  // numbers that no longer match the inputs without saying so.
  const runSig = useMemo(() => JSON.stringify({
    l: stats.annualMWh.toFixed(2), p: stats.peakKW.toFixed(1),
    res, ctx, mode, char, aidc, loc, loadCfg,
    cap: effectiveImportCapKW, sy: simYear,
    price: [costs.EXPORT_PRICE_EUR_PER_MWH],
    up: !!uploadedPrice, ul: !!(csvResult && csvResult.load), ur: !!uploadedResource,
  }), [stats, res, ctx, mode, char, aidc, loc, loadCfg, effectiveImportCapKW, simYear,
       costs.EXPORT_PRICE_EUR_PER_MWH, uploadedPrice, csvResult, uploadedResource]);

  const [runOut, setRunOut] = useState(null);
  const [calib, setCalib] = useState(null);        // dispatch-calibration results, cleared when the run changes
  const [calibBusy, setCalibBusy] = useState("");

  const evaluateDesign = (inputs, overrides) => {
    const forcedResult = overrides && overrides.forcedBatteryResult;
    const inp = overrides ? { ...inputs, ...overrides } : inputs;
    const stepFallback = numz(char.stepKW);
    const d = forcedResult || dispatch(inp);
    const islandLoadKW = stats.peakKW * numz(char.critPct) / 100 + parasiticKWval;
    const engineFirmKW = (inp.engine.enabled ? inp.engine.units * inp.engine.unitKW : 0)
      + (inp.turbine.enabled ? inp.turbine.ratedKW : 0);
    const gridFormingSource = inp.bess.enabled && inp.bess.gridForming ? "bess" : inp.grid.enabled ? "grid" : "engine";
    const islanded = (ctx.islanding !== "none" && ctx.islanding !== "") || ctx.gridStatus === "none"
      || (mode === "aidc" && aidc.gridStrategy === "offgrid");
    const ad = {
      energy: assessEnergyAdequacy({ disp: d, load: inp.load, cal, bess: inp.bess, ctx, islandLoadKW, engineFirmKW }),
      power: assessPowerAdequacy({
        peakKW: stats.peakKW, parasiticKW: parasiticKWval,
        grid: { enabled: inp.grid.enabled, firmCapKW: ctx.gridStatus === "flexible" ? ctx.flexReducedCapKW : inp.grid.importCapKW },
        bess: inp.bess, engine: inp.engine, turbine: inp.turbine, gridFormingSource,
        applyN1: (ctx.islanding !== "none" && ctx.islanding !== "") || ctx.gridStatus === "none" }),
      dynamic: assessDynamicAdequacy({
        stepKW: mode === "aidc" && !char.touched && aidcOut ? aidcOut.stepKW : stepFallback,
        motorKW: numz(char.motorKW), motorMethod: char.motorMethod,
        bess: inp.bess, engine: inp.engine, turbine: inp.turbine, islanded, disp: d, islandLoadKW }),
    };
    return { disp: d, adeq: ad, inputs: inp };
  };

  const itEnergyMWh = mode === "aidc" && aidcDerived ? aidcDerived.itKW * H / 1000 : 0;

  /* Alternative designs, priced on the same basis, for the LCOE comparison.
     Always evaluated with the rule-based dispatch so the comparison is quick
     and like-for-like; the headline design keeps whatever method is selected. */
  const buildVariants = (inputs) => {
    const priceOne = (label, over, resOver, note) => {
      const inp = { ...inputs, ...over };
      const d = dispatch(inp);
      const rv = { ...resN, ...resOver };
      const cst = computeCosts({ res: rv, ctx: ctxN, loc, disp: d, price, costs, itEnergyMWh,
        gridEnabled: over.grid ? over.grid.enabled : gridForBom.enabled,
        firmCapKW: over.grid ? over.grid.importCapKW : gridForBom.firmCapKW });
      return {
        label, note: note || "",
        lcoe: Math.round(cst.lcoeFacility * 10) / 10,
        capexM: +(cst.capex.total / 1e6).toFixed(1),
        renewablePct: +(d.summary.renewableFraction * 100).toFixed(1),
        importMWh: Math.round(d.summary.importMWh),
        engineMWh: Math.round(d.summary.engineMWh),
        unserved: d.summary.unservedMWh,
      };
    };
    const scaleArr = (arr, f) => {
      if (f === 1) return arr;
      const o = new Float32Array(H);
      for (let i = 0; i < H; i++) o[i] = arr[i] * f;
      return o;
    };
    /* The same site and the same load throughout. Each row changes one thing
       about the design or the connection, and every row is dispatched with the
       merit order so the comparison is like for like. Rows that leave energy
       unserved are still shown, because "this option does not work" is an
       answer, but their cost per MWh is not comparable and says so. */
    const out = [];
    const peakPlusAuxKW = stats.peakKW + parasiticKWval;
    const engineUnitKW = numz(res.engine.unitKW) || 1600;
    const none = {
      pvGen: new Float32Array(H), windGen: new Float32Array(H),
      bess: { ...inputs.bess, enabled: false }, engine: { ...inputs.engine, enabled: false },
      turbine: { ...inputs.turbine, enabled: false },
    };
    const noneRes = {
      pv: { ...resN.pv, enabled: false }, wind: { ...resN.wind, enabled: false },
      bess: { ...resN.bess, enabled: false }, engine: { ...resN.engine, enabled: false },
      turbine: { ...resN.turbine, enabled: false },
    };
    const hasRenew = resN.pv.enabled || resN.wind.enabled;

    if (gridForBom.enabled) {
      out.push(priceOne("Grid only — no microgrid", none, noneRes,
        "every MWh imported; the connection as it stands"));
      if (peakPlusAuxKW > effectiveImportCapKW + 1) {
        out.push(priceOne("Grid reinforcement only", {
          ...none, grid: { ...inputs.grid, importCapKW: peakPlusAuxKW, shaveEnabled: false },
        }, noneRes, `connection raised to ${fmt(peakPlusAuxKW / 1000, 1)} MW, no on-site assets`));
      }
    }
    if (hasRenew || resN.bess.enabled) {
      out.push(priceOne("Half the microgrid, more import", {
        pvGen: scaleArr(inputs.pvGen, 0.5), windGen: scaleArr(inputs.windGen, 0.5),
        bess: { ...inputs.bess, powerKW: inputs.bess.powerKW * 0.5, energyKWh: inputs.bess.energyKWh * 0.5 },
      }, {
        pv: { ...resN.pv, kWp: resN.pv.kWp * 0.5 }, wind: { ...resN.wind, ratedKW: resN.wind.ratedKW * 0.5 },
        bess: { ...resN.bess, powerKW: resN.bess.powerKW * 0.5, energyKWh: resN.bess.energyKWh * 0.5 },
      }, "half the generation and storage of this design"));
      out.push(priceOne("Half again as much microgrid", {
        pvGen: scaleArr(inputs.pvGen, 1.5), windGen: scaleArr(inputs.windGen, 1.5),
        bess: { ...inputs.bess, powerKW: inputs.bess.powerKW * 1.5, energyKWh: inputs.bess.energyKWh * 1.5 },
      }, {
        pv: { ...resN.pv, kWp: resN.pv.kWp * 1.5 }, wind: { ...resN.wind, ratedKW: resN.wind.ratedKW * 1.5 },
        bess: { ...resN.bess, powerKW: resN.bess.powerKW * 1.5, energyKWh: resN.bess.energyKWh * 1.5 },
      }, "50 % more generation and storage, still grid-connected"));
    }
    if (resN.bess.enabled && hasRenew) {
      out.push(priceOne("Renewables only, no storage", { bess: { ...inputs.bess, enabled: false } },
        { bess: { ...resN.bess, enabled: false } }, "the same PV and wind, nothing to time-shift it"));
      out.push(priceOne("Storage only, no renewables",
        { pvGen: new Float32Array(H), windGen: new Float32Array(H) },
        { pv: { ...resN.pv, enabled: false }, wind: { ...resN.wind, enabled: false } },
        "the battery arbitrages the tariff with no generation behind it"));
    }
    /* With and without gas. Adding a fleet is only worth pricing when it can
       actually run: with economic running off it never starts on a connection
       that covers the peak, and the row says so rather than showing a silent
       capital penalty. */
    if (resN.engine.enabled) {
      out.push(priceOne("Without generators", { engine: { ...inputs.engine, enabled: false } },
        { engine: { ...resN.engine, enabled: false } }, "the same design with the fleet removed"));
    } else {
      const units = Math.max(1, Math.ceil(peakPlusAuxKW / engineUnitKW));
      out.push(priceOne(`With gas generators — ${units} × ${fmt(engineUnitKW, 0)} kW`, {
        engine: { ...inputs.engine, enabled: true, units, unitKW: engineUnitKW, fuelType: "gas" },
      }, {
        engine: { ...resN.engine, enabled: true, units, unitKW: engineUnitKW, fuelType: "gas" },
      }, res.engine.economicRun
        ? "the fleet runs whenever gas undercuts the import price"
        : "economic running is off, so the fleet is standby only and never starts"));
    }
    if (gridForBom.enabled) {
      out.push(priceOne("Off-grid — this design, no connection", {
        grid: { ...inputs.grid, enabled: false, importCapKW: 0, exportCapKW: 0 },
      }, {}, "the connection removed with no other change"));
    }
    return out;
  };

  /* The single path from a set of inputs to an hourly result. The headline run
     and every auto-size candidate go through this, so a design applied from the
     sweep reproduces exactly the number the sweep reported. */
  const dispatchFor = (inputs) => {
    const optimised = res.dispatchMode === "optimised" && inputs.bess.enabled && inputs.bess.energyKWh > 0;
    const d = optimised
      ? optimiseWithDemandCharge(inputs, loc.capacityCharge_EUR_per_kW_yr)
      : dispatch(inputs);
    return { disp: d, optimised };
  };

  const withWear = (inputs) => ({ ...inputs,
    bess: { ...inputs.bess, wearCostEURperMWh: numz(res.optWearCost) } });

  const runDispatch = () => {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const inputs = withWear(dispatchInputs);
    const { disp: d, optimised } = dispatchFor(inputs);
    const ad = evaluateDesign(inputs, { forcedBatteryResult: d }).adeq;
    const b = buildBOM({
      res: resN, ctx: ctxN, grid: gridForBom, disp: d,
      aidcLimits: mode === "aidc" ? { pvAreaPerKWp: aidc.pvAreaPerKWp, bessFootprint: aidc.bessFootprint, engineFootprint: aidc.engineFootprint } : null,
    });
    const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    const variants = buildVariants(inputs);
    const st = selfTest(d, inputs, cal);
    const dg = dispatchDiagnostics(d, inputs, loc);
    const myopic = dispatch({ ...inputs, lookahead: { ...resN.lookahead, enabled: false } });
    const msWithTest = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    setJustRan(true);
    if (typeof window !== "undefined") window.setTimeout(() => setJustRan(false), 4000);
    setRunOut({ sig: runSig, disp: d, adeq: ad, bom: b, ms, msWithTest, selfTest: st, diag: dg, optimised, variants, myopicPeakKW: myopic.summary.peakImportKW, myopicCurtailMWh: myopic.summary.curtailRenewMWh, at: new Date().toLocaleTimeString() });
  };

  useEffect(() => { if (!runOut) runDispatch(); });
  // Applying a design, or loading a project, runs the model straight away: the
  // state has settled by the time this effect fires, so the run uses the new
  // values rather than the ones on screen a moment ago.
  useEffect(() => { if (autoRun) { setAutoRun(false); runDispatch(); } });

  const stale = !runOut || runOut.sig !== runSig;
  const disp = runOut ? runOut.disp : null;
  const hourlyMatch = useMemo(() => (runOut ? hourlyRenewableMatch(runOut.disp, withWear(dispatchInputs),
    CONSTANTS.HOURLY_MATCH_THRESHOLD_PCT) : null), [runOut, dispatchInputs]);
  useEffect(() => { setCalib(null); setCalibBusy(""); }, [runOut ? runOut.sig : null]);

  const runCalibration = async () => {
    if (!runOut || calibBusy) return;
    setCalibBusy("preparing");
    await new Promise((r) => setTimeout(r, 30));
    try {
      const inputs = withWear(dispatchInputs);
      const res2 = await dispatchCalibration({
        inp: inputs, loc, costs: numz(costs),
        headline: runOut.disp, headlineOptimised: !!runOut.optimised,
        onPhase: (ph) => setCalibBusy(ph),
      });
      setCalib({ sig: runOut.sig, ...res2 });
    } finally {
      setCalibBusy("");
    }
  };
  const adeq = runOut ? runOut.adeq : null;
  const bom = runOut ? runOut.bom : null;
  const dispatchMs = runOut ? runOut.ms : 0;

  // Concrete, quantified moves for any check that did not pass
  const fixes = useMemo(() => (adeq ? remediation(adeq, { res, ctx, stats, char, aidcOut, mode, aidc }) : null),
    [adeq, res, ctx, stats, char, aidcOut, mode, aidc]);

  const dispSeries = useMemo(() => {
    if (!disp) return [];
    const days = view.span === "day" ? 1 : view.span === "week" ? 7 : 30;
    const start = view.startDay * 24, out = [];
    for (let k = 0; k < days * 24; k++) {
      const i = (start + k) % H;
      out.push({
        t: `${dayLabel(cal.doy[i])} ${String(cal.hourOfDay[i]).padStart(2, "0")}h`,
        load: +load[i].toFixed(0), pv: +(disp.pv[i] - Math.min(disp.pv[i], disp.curtail[i])).toFixed(0),
        wind: +disp.wind[i].toFixed(0), imp: +disp.imp[i].toFixed(0),
        bessDis: +Math.max(0, disp.bess[i]).toFixed(0), engine: +disp.engine[i].toFixed(0),
        turbine: +disp.turbine[i].toFixed(0), unserved: +disp.unserved[i].toFixed(0),
        soc: +disp.soc[i].toFixed(1),
      });
    }
    return out;
  }, [view, disp, load, cal]);

  const tableRows = useMemo(() => {
    const rows = [];
    if (!disp) return rows;
    const push = (i) => rows.push({
      i, date: `${dayLabel(cal.doy[i])} ${String(cal.hourOfDay[i]).padStart(2, "0")}h`,
      load: load[i], pv: disp.pv[i], wind: disp.wind[i], imp: disp.imp[i], bess: disp.bess[i],
      soc: disp.soc[i], engine: disp.engine[i], on: disp.enginesOn[i], turbine: disp.turbine[i],
      aux: disp.aux[i], curtail: disp.curtail[i], shed: disp.shed1[i] + disp.shed2[i], unserved: disp.unserved[i],
      reason: REASON_INFO[REASON_CODES[disp.reason[i]]].label, code: REASON_CODES[disp.reason[i]],
    });
    if (reasonFilter >= 0) { for (let i = 0; i < H && rows.length < 1000; i++) if (disp.reason[i] === reasonFilter) push(i); }
    else {
      const days = view.span === "day" ? 1 : view.span === "week" ? 7 : 30;
      const start = view.startDay * 24;
      for (let k = 0; k < days * 24; k++) push((start + k) % H);
    }
    return rows;
  }, [disp, load, cal, view, reasonFilter]);

  /* --- Phase 3: adequacy ------------------------------------------------- */
  /* --- Phase 4: costs and LCOE -------------------------------------------- */
  const cost = useMemo(() => (disp ? computeCosts({
    res: resN, ctx: ctxN, loc, disp, price, costs, itEnergyMWh,
    gridEnabled: gridForBom.enabled, firmCapKW: gridForBom.firmCapKW,
  }) : null), [res, ctx, loc, disp, price, costs, itEnergyMWh, gridForBom.enabled, gridForBom.firmCapKW]);
  const sens = useMemo(() => (disp && cost ? lcoeSensitivity({ res, ctx, disp, costs }, cost) : []), [res, ctx, disp, costs, cost]);

  /* --- Phase 6: baseline, financials, emissions ---------------------------- */
  const baseline = useMemo(() => computeBaseline({
    load, price, loc, gridEnabled: gridForBom.enabled, res: resN, costs, cal,
  }), [load, price, loc, gridForBom.enabled, res, costs, cal]);
  const financials = useMemo(() => (cost && fin.enabled
    ? computeFinancials({ cost, baseline, ctx: ctxN, fin }) : null), [cost, baseline, ctxN, fin]);
  const emissions = useMemo(() => {
    if (!disp) return { totalTCO2: 0, gridTCO2: 0, fuelTCO2: 0 };
    const gridT = disp.summary.importMWh * loc.gridCO2_g_per_kWh / 1000;
    const fuelT = res.engine.fuelType === "diesel"
      ? disp.summary.fuelLitres * CONSTANTS.COST_DEFAULTS.CO2_KG_PER_LITRE_DIESEL / 1000
      : disp.summary.fuelMWhTh * CONSTANTS.COST_DEFAULTS.CO2_KG_PER_MWH_GAS / 1000;
    return { totalTCO2: gridT + fuelT, gridTCO2: gridT, fuelTCO2: fuelT };
  }, [disp, loc, res.engine.fuelType]);

  const energyBalance = useMemo(() => (disp ? ([
    { name: "Load served", value: +(disp.summary.loadMWh - disp.summary.unservedMWh).toFixed(0) },
    { name: "PV generated", value: +disp.summary.pvMWh.toFixed(0) },
    { name: "Wind generated", value: +disp.summary.windMWh.toFixed(0) },
    { name: "Grid import", value: +disp.summary.importMWh.toFixed(0) },
    { name: "Engines", value: +(disp.summary.engineMWh + disp.summary.turbineMWh).toFixed(0) },
    { name: "Curtailed", value: +disp.summary.curtailRenewMWh.toFixed(0) },
    { name: "Exported", value: +disp.summary.exportMWh.toFixed(0) },
    { name: "Unserved", value: +disp.summary.unservedMWh.toFixed(2) },
  ].filter((r) => r.value > 0)) : []), [disp]);

  const monthlyMix = useMemo(() => {
    if (!disp) return [];
    const acc = Array.from({ length: 12 }, () => ({ pv: 0, wind: 0, imp: 0, engine: 0 }));
    for (let i = 0; i < H; i++) {
      const m = cal.month[i];
      acc[m].pv += (disp.pv[i] - Math.min(disp.pv[i], disp.curtail[i])) / 1000;
      acc[m].wind += disp.wind[i] / 1000;
      acc[m].imp += disp.imp[i] / 1000;
      acc[m].engine += (disp.engine[i] + disp.turbine[i]) / 1000;
    }
    return acc.map((v, i) => ({ m: MONTHS[i], pv: +v.pv.toFixed(0), wind: +v.wind.toFixed(0), imp: +v.imp.toFixed(0), engine: +v.engine.toFixed(0) }));
  }, [disp, cal]);

  const monthlyChart = useMemo(() => stats.monthlyMWh.map((v, i) => ({
    m: MONTHS[i], load: +v.toFixed(0),
    yield: +(loc.monthlyYieldShare[i] / loc.monthlyYieldShare.reduce((a, b) => a + b, 0) * loc.specificYield_kWh_per_kWp).toFixed(0),
    temp: +Number(loc.tempMeanC[i]).toFixed(1),
  })), [stats, loc]);

  /* --- Handlers ------------------------------------------------------------ */
  const onLoadFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { const res = parseLoadCSV(String(r.result)); setCsvResult(res); if (res.load) setLoadCfg((s) => ({ ...s, path: "csv" })); };
    r.readAsText(f);
  };

  /* Apply a configuration to the whole tool. Used by the file loader and by the
     built-in examples, so both behave identically. */
  const applyConfig = (c, sourceLabel, extraMessages = []) => {
    if (c.mode) setMode(c.mode);
    if (c.ctx) setCtx(c.ctx);
    setLocOverride(c.locOverride || {});
    if (c.aidc) setAidc(c.aidc);
    if (c.loadCfg) setLoadCfg(c.loadCfg);
    if (c.char) setChar(c.char);
    if (c.res) setRes(c.res);
    if (c.costs) setCosts({ ...CONSTANTS.COST_DEFAULTS, ...c.costs });
    if (c.fin) setFin(c.fin);
    if (c.sweep) setSweep((s2) => ({ ...s2, ...c.sweep })); // merged: older files carry no search-method field
    if (c.lcoeBoundary) setLcoeBoundary(c.lcoeBoundary);
    setScenarios(Array.isArray(c.scenarios) ? c.scenarios.slice(0, 6) : []);
    setProjectName(c.projectName || "");
    setProjectNotes(c.notes || "");
    setLastImported(sourceLabel);
    setCsvResult(c.uploadedLoad && c.uploadedLoad.length === H
      ? { load: Float32Array.from(c.uploadedLoad), notes: c.uploadedLoadNotes || ["Restored from a project file."], rowsIn: H, detected: "hourly" }
      : null);
    if (c.uploadedResource && (c.uploadedResource.pvUnit || c.uploadedResource.temp)) {
      const nx = {};
      if (c.uploadedResource.pvUnit) nx.pvUnit = Float32Array.from(c.uploadedResource.pvUnit);
      if (c.uploadedResource.temp) nx.temp = Float32Array.from(c.uploadedResource.temp);
      setUploadedResource(nx);
    } else setUploadedResource(null);
    setUploadedPrice(c.uploadedPrice && c.uploadedPrice.length === H ? Float32Array.from(c.uploadedPrice) : null);
    if (c.resourceSource) setResourceSource(c.resourceSource);
    setRunOut(null);
    setSweepOut(null);
    setConfigMsgs([`Loaded "${c.projectName || sourceLabel}".`, ...extraMessages, "The model is running with these inputs."]);
    setAutoRun(true);
  };

  const loadProject = (ev) => {
    const f = ev.target.files?.[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const { ok, config: c, messages } = parseConfig(String(rd.result));
      if (!ok) { setConfigMsgs(messages); return; }
      applyConfig(c, `${f.name}${c.savedAt ? ` (saved ${c.savedAt.slice(0, 10)})` : ""}`, messages);
    };
    rd.readAsText(f);
    ev.target.value = "";
  };

  const loadExample = (key) => {
    const ex = EXAMPLE_PROJECTS[key];
    if (!ex) return;
    applyConfig(JSON.parse(JSON.stringify(ex.config)), `built-in example: ${ex.label}`,
      ["Every input can be edited and the result saved as your own project file."]);
  };

  const onPriceFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const parsed = Papa.parse(String(rd.result).trim(), { header: true, skipEmptyLines: true, dynamicTyping: true });
      const rows = parsed.data;
      if (!rows.length) { setPriceNote("No rows found in that file."); return; }
      const keys = Object.keys(rows[0]);
      const col = keys.find((k) => /price|eur|mwh|day.?ahead|spot/i.test(k)) || keys[keys.length - 1];
      const vals = rows.map((r) => Number(r[col])).filter((v) => !isNaN(v));
      if (vals.length < 100) { setPriceNote(`Column "${col}" contained too few numbers to use.`); return; }
      const arr = new Float32Array(H);
      for (let i = 0; i < H; i++) arr[i] = vals[i % vals.length];
      setUploadedPrice(arr);
      setRes((s2) => ({ ...s2, tariff: { ...s2.tariff, structure: "uploaded" } }));
      let mean = 0; for (let i = 0; i < H; i++) mean += arr[i];
      setPriceNote(`${vals.length} prices read from column "${col}", annual mean ${(mean / H).toFixed(1)} €/MWh before grid fees.${vals.length !== H ? ` The series was ${vals.length} long and has been repeated to fill 8760 hours.` : ""}`);
    };
    rd.readAsText(f);
    e.target.value = "";
  };

  const onResourceFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const res = Papa.parse(String(r.result).trim(), { header: true, skipEmptyLines: true, dynamicTyping: true });
      const rows = res.data;
      if (!rows.length) { setResourceSource((s) => ({ ...s, note: "No rows found in the resource file." })); return; }
      const keys = Object.keys(rows[0]).map((k) => k.toLowerCase());
      const findKey = (re) => Object.keys(rows[0])[keys.findIndex((k) => re.test(k))];
      const gk = findKey(/ghi|irrad|g\(i\)|production|kwh|kw\b|p_pv|specific/);
      const tk = findKey(/temp|t2m|ambient|dry/);
      const next = {}; const notes = [];
      if (gk) {
        const v = rows.map((r0) => Number(r0[gk]) || 0);
        const arr = new Float32Array(H);
        for (let i = 0; i < H; i++) arr[i] = v[i % v.length];
        let s = 0; for (let i = 0; i < H; i++) s += arr[i];
        if (s > 5000) { const k = loc.specificYield_kWh_per_kWp / s; for (let i = 0; i < H; i++) arr[i] *= k; notes.push("Resource column scaled to the stated specific yield."); }
        next.pvUnit = arr;
      }
      if (tk) {
        const v = rows.map((r0) => Number(r0[tk]) || 0);
        const arr = new Float32Array(H);
        for (let i = 0; i < H; i++) arr[i] = v[i % v.length];
        next.temp = arr;
      }
      setUploadedResource(Object.keys(next).length ? next : null);
      setResourceSource({ pv: next.pvUnit ? "site" : "library", temp: next.temp ? "site" : "library", note: `${rows.length} rows read. ${gk ? `Resource column "${gk}". ` : "No resource column found. "}${tk ? `Temperature column "${tk}". ` : "No temperature column found. "}${notes.join(" ")}` });
    };
    r.readAsText(f);
  };

  const setCooling = (t) => {
    const c = CONSTANTS.COOLING[t];
    const climateAdder = Math.min(CONSTANTS.PUE_CLIMATE_ADDER_MAX,
      Math.max(0, (annualMeanT - CONSTANTS.PUE_CLIMATE_REF_TEMP_C) * CONSTANTS.PUE_CLIMATE_ADDER_PER_C));
    setAidc((s) => ({ ...s, coolingType: t, designPUE: +(c.designPUE + climateAdder).toFixed(3), freeCoolingBelowC: c.freeCoolingBelowC, designAmbientC: c.designAmbientC, pueTouched: false }));
  };

  const applyUseCase = (k) => {
    const d = USE_CASE_FAMILIES[k].defaults;
    setCtx((s) => ({ ...s, useCase: k, islanding: d.islanding, autonomyH: d.autonomyH }));
    if (!char.touched) setChar((s) => ({ ...s, critPct: d.critPct, shed1Pct: Math.round((100 - d.critPct) * 0.6), shed2Pct: 100 - d.critPct - Math.round((100 - d.critPct) * 0.6) }));
  };

  const aidcTrace = aidcDerived && aidcOut ? [
    { label: "IT draw", expr: `${fmt(aidcYearMW, 1)} MW IT × ${fmt(aidc.itUtilisationPct, 0)} % utilisation`, result: `${fmt(aidcDerived.itKW / 1000, 2)} MW` },
    { label: "Non-cooling overhead", expr: `IT × ${fmt(aidcDerived.otherPct, 1)} % (UPS ${aidc.upsPresent ? CONSTANTS.UPS_LOSS_PCT_OF_IT : 0} + dist ${CONSTANTS.DISTRIBUTION_LOSS_PCT_OF_IT} + misc ${CONSTANTS.MISC_LOAD_PCT_OF_IT})`, result: `${fmt(aidcDerived.otherKW / 1000, 2)} MW` },
    { label: "Cooling at design", expr: `IT × (PUE ${fmt(aidc.designPUE, 3)} − 1) − overhead, quoted at ${fmt(aidc.designAmbientC, 0)} °C`, result: `${fmt(aidcDerived.coolingDesignKW / 1000, 2)} MW` },
    { label: "Free cooling", expr: `hours at or below ${fmt(aidc.freeCoolingBelowC, 0)} °C dry bulb`, result: `${fmt(aidcDerived.freeHours, 0)} h/yr (${fmt(100 * aidcDerived.freeHours / H, 0)} %)` },
    { label: "Annualised PUE", expr: `facility energy ÷ IT energy over 8760 h at ${loc.label}`, result: fmt(aidcDerived.annualisedPUE, 3) },
    { label: "Peak, typical year", expr: `max of hourly IT + cooling(T) + overhead over 8760 h`, result: `${fmt(aidcOut.peakMW, 2)} MW` },
    { label: "Load at design ambient", expr: `IT + cooling at 100 % of design + overhead, at ${fmt(aidc.designAmbientC, 0)} °C`, result: `${fmt(aidcOut.designPeakMW, 2)} MW` },
    { label: "Firm capacity req.", expr: `max(typical peak, design load) ${fmt(aidcOut.sizingBasisMW, 2)} MW × ${fmt(aidcOut.red.firmFactor, 2)} (${aidcOut.red.label})`, result: `${fmt(aidcOut.firmMW, 2)} MW` },
    { label: "Largest load step", expr: `IT ${fmt(aidcDerived.itKW / 1000, 2)} MW × ${fmt(aidc.loadSwingPct, 0)} % swing over ${fmt(aidc.loadSwingSeconds, 0)} s`, result: `${fmt(aidcOut.stepKW / 1000, 2)} MW` },
    { label: "PV cap from land", expr: `${fmt(aidc.landPV_ha, 1)} ha × 10 000 m²/ha ÷ ${fmt(aidc.pvAreaPerKWp, 1)} m²/kWp`, result: `${fmt(aidcOut.maxKWp / 1000, 2)} MWp max` },
    { label: "BESS cap from area", expr: `${fmt(aidc.landBESS_m2, 0)} m² ÷ ${fmt(aidc.bessFootprint, 0)} m²/MW`, result: `${fmt(aidcOut.maxBessMW, 1)} MW max` },
    { label: "Engine cap from area", expr: `${fmt(aidc.landEngine_m2, 0)} m² ÷ ${fmt(aidc.engineFootprint, 0)} m²/MW`, result: `${fmt(aidcOut.maxEngineMW, 1)} MW max` },
  ] : [];

  /* --- Auto-size sweep ------------------------------------------------------ */
  const linSpace = (min, max, n) => {
    if (n <= 1) return [min];
    const out = []; for (let i = 0; i < n; i++) out.push(min + (max - min) * i / (n - 1));
    return out;
  };
  const parseList = (t2) => String(t2).split(",").map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v));

  const sweepUnitKW = numz(sweep.engineUnitKW) || numz(res.engine.unitKW) || 1600;

  const sweepBounds = () => {
    const pvCap = maxPVfromLandKWp > 0 ? maxPVfromLandKWp / 1000 : Infinity;
    const bessCap = mode === "aidc" && aidcOut && aidcOut.maxBessMW > 0 ? aidcOut.maxBessMW : Infinity;
    const engCap = mode === "aidc" && aidcOut && aidcOut.maxEngineMW > 0 ? aidcOut.maxEngineMW : Infinity;
    return {
      pvKWp: sweep.includePV
        ? linSpace(numz(sweep.pvMin), Math.min(numz(sweep.pvMax), pvCap), Math.max(1, numz(sweep.pvSteps))).map((v) => Math.round(v * 1000))
        : [0],
      windKW: sweep.includeWind
        ? linSpace(numz(sweep.windMin), numz(sweep.windMax), Math.max(1, numz(sweep.windSteps))).map((v) => Math.round(v * 1000))
        : [0],
      bessMW: sweep.includeBess
        ? linSpace(numz(sweep.bessMin), Math.min(numz(sweep.bessMax), bessCap), Math.max(1, numz(sweep.bessSteps)))
        : [0],
      bessHours: sweep.includeBess ? (parseList(sweep.durations).length ? parseList(sweep.durations) : [2]) : [0],
      engineUnits: sweep.includeEngine
        ? (parseList(sweep.engineUnits).length ? parseList(sweep.engineUnits) : [0]).filter((u) => u * sweepUnitKW / 1000 <= engCap)
        : [0],
    };
  };

  const sweepCount = useMemo(() => {
    const b2 = sweepBounds();
    return b2.pvKWp.length * b2.windKW.length * b2.bessMW.length * b2.bessHours.length * Math.max(1, b2.engineUnits.length);
  }, [sweep, maxPVfromLandKWp, mode, aidcOut, res.engine.unitKW]);

  /* One evaluator for every search path — manual sweep, guided screening and
     shortlist re-pricing all build the candidate the same way, so the only
     thing that can differ between them is the dispatch method, and that is
     printed on the result. The generation profile depends only on kWp, so it
     is cached per PV size. */
  const makeCandidateEvaluator = (method, unitKW, engineOpts) => {
    const fuelType = (engineOpts && engineOpts.fuelType) || res.engine.fuelType || "diesel";
    const pvCache = new Map();
    const useOpt = method === "optimised";
    return (c) => {
      if (!pvCache.has(c.kWp)) {
        pvCache.set(c.kWp, c.kWp > 0 ? buildPVGen(pvUnit, { ...res.pv, enabled: true, kWp: c.kWp }, simYear).gen : new Float32Array(H));
      }
      const pvGen = pvCache.get(c.kWp);
      const windGenC = c.windKW > 0 ? buildWindGen(windSpeed, temp, { ...res.wind, ratedKW: c.windKW }) : new Float32Array(H);
      const overrides = {
        pvGen, windGen: windGenC,
        bess: { ...dispatchInputs.bess, enabled: c.bessKW > 0, powerKW: c.bessKW, energyKWh: c.bessKWh },
        engine: { ...dispatchInputs.engine, enabled: c.units > 0, units: c.units, unitKW,
          minStableLoadPct: numz(res.engine.minStableLoadPct) || CONSTANTS.ENGINE_MIN_STABLE_LOAD_PCT,
          annualHourLimit: numz(res.engine.annualHourLimit) || CONSTANTS.HOURS_PER_YEAR,
          fuelType },
      };
      const inpC = withWear({ ...dispatchInputs, ...overrides });
      // Same rule as the headline path: the optimiser needs a battery to optimise.
      const d = useOpt && c.bessKW > 0
        ? optimiseWithDemandCharge(inpC, loc.capacityCharge_EUR_per_kW_yr)
        : dispatch(inpC);
      const { adeq: ad } = evaluateDesign(inpC, { forcedBatteryResult: d });
      // Costed from the sanitised copy, exactly as the headline run is, so a
      // blank field cannot price differently in the two places.
      const resVariant = {
        ...resN, pv: { ...resN.pv, enabled: c.kWp > 0, kWp: c.kWp },
        wind: { ...resN.wind, enabled: c.windKW > 0, ratedKW: c.windKW },
        bess: { ...resN.bess, enabled: c.bessKW > 0, powerKW: c.bessKW, energyKWh: c.bessKWh },
        engine: { ...resN.engine, enabled: c.units > 0, units: c.units, unitKW, fuelType },
      };
      const cst = computeCosts({ res: resVariant, ctx: ctxN, loc, disp: d, price, costs, itEnergyMWh,
        gridEnabled: gridForBom.enabled, firmCapKW: gridForBom.firmCapKW });
      const feasible = ad.energy.verdict !== "FAIL" && ad.power.verdict !== "FAIL" && ad.dynamic.verdict !== "FAIL";
      return {
        lcoe: +cst.lcoeFacility.toFixed(1),
        capexMEUR: +(cst.capex.total / 1e6).toFixed(2),
        renewablePct: +(d.summary.renewableFraction * 100).toFixed(1),
        unservedMWh: +d.summary.unservedMWh.toFixed(2),
        fuelDisplay: fuelType === "diesel" ? d.summary.fuelLitres / 1000 : d.summary.fuelMWhTh,
        engineMWh: +d.summary.engineMWh.toFixed(0),
        engineHours: d.summary.engineHours,
        fuelType,
        energy: ad.energy.verdict, power: ad.power.verdict, dynamic: ad.dynamic.verdict, feasible,
        method: useOpt ? "optimised" : "merit",
      };
    };
  };

  /* Guided search space — proposed from the load, the connection, the resource
     and the land, then adjusted by any override entered on the tab. */
  const windAnnualMWhPerMW = useMemo(() => {
    let e = 0; const g = buildWindGen(windSpeed, temp, { ...res.wind, ratedKW: 1000 });
    for (let i = 0; i < H; i++) e += g[i];
    return e / 1000; // MWh per year per MW installed
  }, [windSpeed, temp, res.wind]);

  const engineMarginalEURperMWh = useMemo(() => engineMarginalCostEURperMWh(
    { ...res.engine, sfcDiesel: CONSTANTS.DIESEL_SFC_L_PER_KWH, effGas: CONSTANTS.GAS_ENGINE_EFF_PCT,
      omEURperRunHourPerMW: numz(costs.OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW) },
    numz(loc.diesel_EUR_per_litre), numz(loc.gas_EUR_per_MWh_th)),
    [res.engine, costs.OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW, loc.diesel_EUR_per_litre, loc.gas_EUR_per_MWh_th]);

  const sweepFuelType = sweep.gEngineFuel === "project"
    ? (res.engine.fuelType || "gas") : sweep.gEngineFuel;
  const sweepEngineMarginal = useMemo(() => engineMarginalCostEURperMWh(
    { ...res.engine, fuelType: sweepFuelType, sfcDiesel: CONSTANTS.DIESEL_SFC_L_PER_KWH,
      effGas: CONSTANTS.GAS_ENGINE_EFF_PCT, omEURperRunHourPerMW: numz(costs.OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW) },
    numz(loc.diesel_EUR_per_litre), numz(loc.gas_EUR_per_MWh_th)),
    [res.engine, sweepFuelType, costs.OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW,
     loc.diesel_EUR_per_litre, loc.gas_EUR_per_MWh_th]);

  const proposedSpace = useMemo(() => proposeSearchSpace({
    load, stats, pvUnit,
    windAnnualMWhPerMW, windMean: numz(loc.windMean_m_s_100m) || 0,
    gridEnabled: dispatchInputs.grid.enabled, importCapKW: effectiveImportCapKW,
    parasiticKW: parasiticKWval,
    islanded: (ctx.islanding !== "none" && ctx.islanding !== "") || ctx.gridStatus === "none"
      || (mode === "aidc" && aidc.gridStrategy === "offgrid"),
    islandLoadKW: stats.peakKW * numz(char.critPct) / 100 + parasiticKWval,
    landCapKWp: maxPVfromLandKWp,
    bessCapMW: mode === "aidc" && aidcOut && aidcOut.maxBessMW > 0 ? aidcOut.maxBessMW : 0,
    engineCapMW: mode === "aidc" && aidcOut && aidcOut.maxEngineMW > 0 ? aidcOut.maxEngineMW : 0,
    engineUnitKW: numz(sweep.gEngineUnitKW) || numz(res.engine.unitKW) || 1600,
    mode,
    exportCapKW: numz(ctx.exportCapKW), dcacRatio: numz(res.pv.dcacRatio) || 1.2,
    windCapexEURperKW: numz(costs.WIND_EUR_PER_KW), windOMEURperKWyr: numz(costs.OM_WIND_EUR_PER_KW_YR),
    deliveredGridEURperMWh: (numz(loc.importTariff_EUR_per_MWh) || 0) + (numz(loc.gridFee_EUR_per_MWh) || 0),
    discountPct: numz(ctx.discountPct), lifeYears: numz(ctx.lifeYears),
    engineEconomicRun: !!res.engine.economicRun, engineMarginalEURperMWh: sweepEngineMarginal,
    engineFuelType: sweepFuelType,
  }), [load, stats, pvUnit, windAnnualMWhPerMW, loc, dispatchInputs.grid.enabled, effectiveImportCapKW,
    parasiticKWval, ctx, mode, aidc, char.critPct, maxPVfromLandKWp, aidcOut, sweep.gEngineUnitKW, res.engine.unitKW,
    costs.WIND_EUR_PER_KW, costs.OM_WIND_EUR_PER_KW_YR, res.engine.economicRun, sweepEngineMarginal, sweepFuelType]);

  /* The space the search actually runs on: the proposal with overrides applied.
     An override moves the bound; the coarse levels are re-clipped to it. */
  const guidedSpace = useMemo(() => {
    const p = proposedSpace;
    const ovr = (on, def) => (on === null || on === undefined ? def : on);
    const cap = (v, ovrMax) => (numz(ovrMax) > 0 ? Math.min(v, numz(ovrMax)) : v);
    const pvMax = numz(sweep.gPvMaxMWp) > 0 ? numz(sweep.gPvMaxMWp) * 1000 : p.pv.maxKWp;
    const windMax = numz(sweep.gWindMaxMW) > 0 ? numz(sweep.gWindMaxMW) * 1000 : p.wind.maxKW;
    const bessMax = numz(sweep.gBessMaxMW) > 0 ? numz(sweep.gBessMaxMW) * 1000 : p.bess.maxKW;
    return {
      pv: { ...p.pv, include: ovr(sweep.gPvOn, p.pv.include), maxKWp: pvMax,
        levelsKWp: [...new Set(p.pv.levelsKWp.map((v) => Math.min(v, pvMax)))] },
      wind: { ...p.wind, include: ovr(sweep.gWindOn, p.wind.include), maxKW: windMax,
        levelsKW: [...new Set(p.wind.levelsKW.map((v) => Math.min(v, windMax)))] },
      bess: { ...p.bess, include: ovr(sweep.gBessOn, p.bess.include), maxKW: bessMax,
        levelsKW: [...new Set(p.bess.levelsKW.map((v) => Math.min(v, bessMax)))] },
      engine: { ...p.engine, include: ovr(sweep.gEngineOn, p.engine.include) },
    };
  }, [proposedSpace, sweep.gPvOn, sweep.gWindOn, sweep.gBessOn, sweep.gEngineOn,
    sweep.gPvMaxMWp, sweep.gWindMaxMW, sweep.gBessMaxMW]);

  const guidedCoarseCount = useMemo(() => {
    const g = guidedSpace;
    const pv = g.pv.include ? g.pv.levelsKWp.length : 1;
    const wi = g.wind.include ? g.wind.levelsKW.length : 1;
    const beNZ = g.bess.include ? g.bess.levelsKW.filter((v) => v > 0).length : 0;
    const be = 1 + beNZ * (g.bess.include ? g.bess.durationsH.length : 0);
    const en = g.engine.include ? g.engine.levels.length : 1;
    return pv * wi * be * en;
  }, [guidedSpace]);

  /* A running clock while a search is under way. A sweep can take a minute or
     more and the only honest thing to show is how long it has been going. */
  useEffect(() => {
    if (!sweeping || !sweepStartedAt) return undefined;
    const id = setInterval(() => setSweepElapsedS((Date.now() - sweepStartedAt) / 1000), 500);
    return () => clearInterval(id);
  }, [sweeping, sweepStartedAt]);

  const runGuided = async () => {
    setSweeping(true); setSweepPct(0); setSweepStartedAt(Date.now()); setSweepElapsedS(0);
    await new Promise((r) => setTimeout(r, 30)); // let the running state paint before the work starts
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const unitKW = numz(sweep.gEngineUnitKW) || numz(res.engine.unitKW) || 1600;
    const engineOpts = { fuelType: sweepFuelType };
    const evalMerit = makeCandidateEvaluator("merit", unitKW, engineOpts);
    const evalOpt = res.dispatchMode === "optimised" ? makeCandidateEvaluator("optimised", unitKW, engineOpts) : null;
    const out = await autoSizeGuided({
      space: guidedSpace, evaluate: evalMerit, evaluateOpt: evalOpt,
      tick: () => new Promise((r) => setTimeout(r, 0)),
      onProgress: (pct) => setSweepPct(pct),
    });
    out.failCounts = { energy: 0, power: 0, dynamic: 0 };
    out.all.forEach((r) => {
      if (r.energy === "FAIL") out.failCounts.energy++;
      if (r.power === "FAIL") out.failCounts.power++;
      if (r.dynamic === "FAIL") out.failCounts.dynamic++;
    });
    const contributions = assetContribution(out.all, out.best, guidedSpace);
    const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    setSweepOut({ ...out, kind: "guided", contributions, space: guidedSpace, unitKW, ms, fuelType: sweepFuelType,
      method: evalOpt ? "merit-order screening, shortlist re-priced under optimisation" : "merit order" });
    setSweeping(false);
  };

  const runAutoSize = async () => {
    setSweeping(true); setSweepPct(0); setSweepStartedAt(Date.now()); setSweepElapsedS(0);
    await new Promise((r) => setTimeout(r, 30)); // let the running state paint before the work starts
    // The search uses the same method as the headline run, so the ranking it
    // produces is the ranking you would get by applying each design and running it.
    const useOptimiser = res.dispatchMode === "optimised";
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    // The search decides whether an asset belongs in the design, so it must be
    // free to test sizes for assets that are currently switched off. Inclusion
    // is controlled here, not by the Equipment toggles.
    const bounds = sweepBounds();
    const out = await autoSize({
      bounds,
      evaluate: makeCandidateEvaluator(useOptimiser ? "optimised" : "merit", sweepUnitKW, { fuelType: sweepFuelType }),
      tick: () => new Promise((r) => setTimeout(r, 0)),
      onProgress: (pct) => setSweepPct(pct),
    });
    out.failCounts = { energy: 0, power: 0, dynamic: 0 };
    out.all.forEach((r) => {
      if (r.energy === "FAIL") out.failCounts.energy++;
      if (r.power === "FAIL") out.failCounts.power++;
      if (r.dynamic === "FAIL") out.failCounts.dynamic++;
    });
    out.ranked = [...out.all].sort((x, y) => (x.feasible === y.feasible ? x.lcoe - y.lcoe : (x.feasible ? -1 : 1)));
    const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    setSweepOut({ ...out, ms, method: useOptimiser ? "optimisation" : "merit order" });
    setSweeping(false);
  };

  const applyCandidate = (c) => {
    // The sweep priced this design with the method selected at the time; keep it
    // selected so the run that follows reproduces the same number.
    if (c.method) setRes((s2) => ({ ...s2, dispatchMode: c.method === "optimised" ? "optimised" : "merit" }));
    const unitKW = (sweepOut && sweepOut.kind === "guided" && sweepOut.unitKW) ? sweepOut.unitKW : sweepUnitKW;
    setRes((s2) => ({
      ...s2,
      pv: { ...s2.pv, enabled: c.kWp > 0, kWp: c.kWp },
      wind: { ...s2.wind, enabled: (c.windKW || 0) > 0, ratedKW: c.windKW || 0 },
      bess: { ...s2.bess, enabled: c.bessKW > 0, powerKW: c.bessKW, energyKWh: c.bessKWh },
      engine: { ...s2.engine, enabled: c.units > 0, units: c.units, unitKW,
        fuelType: c.fuelType || s2.engine.fuelType || "diesel" },
    }));
    setAutoRun(true);
    setTab(4);
  };

  /* --- AIDC phased build-out: the design tested at every ramp year ---------- */
  const phaseRows = useMemo(() => {
    if (mode !== "aidc" || !aidc.ramp.length) return [];
    return aidc.ramp.map((r) => {
      const d0 = deriveAIDCLoad(aidc, temp, r.mwIT);
      let capKW = ctx.importCapKW;
      if (ctx.gridStatus === "phased" && ctx.phases.length) {
        const sorted = [...ctx.phases].sort((x, y) => x.year - y.year);
        capKW = sorted[0].capKW;
        for (const p2 of sorted) if (r.year >= p2.year) capKW = p2.capKW;
      }
      const st = loadStats(d0.load, cal);
      const inp = { ...dispatchInputs, load: d0.load, grid: { ...dispatchInputs.grid, importCapKW: capKW } };
      const d = dispatch(inp);
      const gapKW = Math.max(0, st.peakKW - capKW);
      const enginesNeeded = res.engine.enabled && res.engine.unitKW > 0 ? Math.ceil(gapKW / res.engine.unitKW) : 0;
      const engineMinKW = res.engine.units * res.engine.unitKW * res.engine.minStableLoadPct / 100;
      const belowMinLoad = res.engine.enabled && gapKW > 0 && gapKW < engineMinKW;
      const islandLoadKW = st.peakKW * char.critPct / 100 + parasiticKWval;
      const ad = {
        energy: assessEnergyAdequacy({ disp: d, load: d0.load, cal, bess: inp.bess, ctx, islandLoadKW,
          engineFirmKW: res.engine.units * res.engine.unitKW }),
        power: assessPowerAdequacy({ peakKW: st.peakKW, parasiticKW: parasiticKWval,
          grid: { enabled: inp.grid.enabled, firmCapKW: capKW }, bess: res.bess, engine: res.engine,
          turbine: res.turbine, gridFormingSource: res.bess.gridForming ? "bess" : "grid",
          applyN1: ctx.islanding !== "none" && ctx.islanding !== "" }),
        dynamic: assessDynamicAdequacy({ stepKW: d0.itKW * aidc.loadSwingPct / 100, motorKW: char.motorKW,
          motorMethod: char.motorMethod, bess: res.bess, engine: res.engine, turbine: res.turbine,
          islanded: ctx.islanding !== "none", disp: d, islandLoadKW }),
      };
      return {
        year: r.year, mwIT: r.mwIT, peakMW: st.peakKW / 1000, capMW: capKW / 1000,
        enginesNeeded, engineMinMW: engineMinKW / 1000, belowMinLoad,
        unservedMWh: d.summary.unservedMWh,
        energy: ad.energy.verdict, power: ad.power.verdict, dynamic: ad.dynamic.verdict,
      };
    });
  }, [mode, aidc, temp, ctx, dispatchInputs, res, cal, char, parasiticKWval]);

  /* --- Scenarios ------------------------------------------------------------ */
  const saveScenario = () => {
    if (!runOut || !cost) return;
    const s2 = {
      name: scenarioName.trim() || `Scenario ${scenarios.length + 1}`,
      pvMWp: res.pv.enabled ? res.pv.kWp / 1000 : 0,
      bessMW: res.bess.enabled ? res.bess.powerKW / 1000 : 0,
      bessMWh: res.bess.enabled ? res.bess.energyKWh / 1000 : 0,
      engines: res.engine.enabled ? res.engine.units : 0,
      importCapMW: effectiveImportCapKW / 1000,
      reserveSoc: res.bess.reserveSocPct,
      yield: loc.specificYield_kWh_per_kWp,
      discount: ctx.discountPct,
      lcoe: +cost.lcoeFacility.toFixed(1),
      capexM: cost.capex.total / 1e6,
      renewablePct: +(disp.summary.renewableFraction * 100).toFixed(1),
      fuel: res.engine.fuelType === "diesel" ? disp.summary.fuelLitres / 1000 : disp.summary.fuelMWhTh,
      emissions: emissions.totalTCO2,
      unservedMWh: disp.summary.unservedMWh,
      energy: adeq.energy.verdict, power: adeq.power.verdict, dynamic: adeq.dynamic.verdict,
      npvM: financials ? financials.npv / 1e6 : 0,
    };
    setScenarios((prev) => [...prev, s2].slice(0, 6));
    setScenarioName("");
  };

  /* --- What the project actually delivers, against doing nothing ----------- */
  const outcome = useMemo(() => {
    if (!runOut || !cost) return null;
    const s2 = disp.summary;
    const capMW = gridForBom.firmCapKW / 1000;

    // Peak shaved: import peak against the site peak it would otherwise draw
    const peakShavedMW = Math.max(0, stats.peakKW / 1000 - s2.peakImportKW / 1000);
    const demandSavingEUR = peakShavedMW * 1000 * loc.capacityCharge_EUR_per_kW_yr;

    // IT capacity the grid alone could support, against the design target
    let itNow = null;
    if (mode === "aidc" && aidcDerived && aidcYearMW > 0) {
      const facilityPerMWIT = aidcDerived.designConditionKW / 1000 / aidcYearMW;   // MW facility per MW IT
      itNow = {
        withoutProject: gridForBom.enabled ? capMW / facilityPerMWIT : 0,
        withProject: aidcYearMW,
        target: aidc.targetMWIT,
        facilityPerMWIT,
      };
    }
    const emissionsBaselineT = baseline.mode === "grid"
      ? baseline.energyMWh * loc.gridCO2_g_per_kWh / 1000
      : baseline.energyMWh / (partLoadValue(CONSTANTS.GAS_ENGINE_EFF_PCT, 75) / 100) * CONSTANTS.COST_DEFAULTS.CO2_KG_PER_MWH_GAS / 1000;

    return {
      peakShavedMW, demandSavingEUR, itNow,
      emissionsBaselineT, emissionsAvoidedT: Math.max(0, emissionsBaselineT - emissions.totalTCO2),
      fuelDisplay: res.engine.fuelType === "diesel" ? s2.fuelLitres / 1000 : s2.fuelMWhTh,
      fuelUnit: res.engine.fuelType === "diesel" ? "kl/yr" : "MWh th/yr",
      autonomyH: adeq.energy.autonomyFromBessH,
      autonomyRequiredH: adeq.energy.autonomyRequiredH,
      unservedMWh: s2.unservedMWh,
      renewablePct: s2.renewableFraction * 100,
      allPass: adeq.energy.verdict === "PASS" && adeq.power.verdict === "PASS" && adeq.dynamic.verdict === "PASS",
    };
  }, [runOut, cost, disp, stats, loc, mode, aidcDerived, aidcYearMW, aidc, gridForBom, baseline, emissions, adeq, res.engine.fuelType]);

  /* Every design worth comparing, cheapest first, with the do-nothing case fixed at the top. */
  const lcoeLadder = useMemo(() => {
    if (!cost || !baseline) return [];
    const rows = [{ name: "Baseline — 100 % grid supply", lcoe: +(baseline.annualCost / Math.max(1, baseline.energyMWh)).toFixed(1) }];
    rows.push({ name: "This design", lcoe: +cost.lcoeFacility.toFixed(1) });
    scenarios.forEach((sc) => rows.push({ name: `Saved: ${sc.name}`, lcoe: +sc.lcoe.toFixed(1) }));
    if (sweepOut && sweepOut.feasible.length) {
      sweepOut.feasible.slice(0, 3).forEach((r, i) => rows.push({
        name: `Auto-size #${i + 1}: ${fmt(r.kWp / 1000, 1)} MWp / ${fmt(r.bessKW / 1000, 1)} MW`, lcoe: r.lcoe,
      }));
    }
    return rows;
  }, [cost, baseline, scenarios, sweepOut]);

  /* The LCOE as one bar, split by what each component contributes.
     The segments sum to the number shown above them, to the cent. */
  const lcoeStack = useMemo(() => {
    if (!cost || cost.lcoeFacility <= 0) return null;
    // Scale to the displayed boundary so the bar always totals the number on screen
    const k = lcoeBoundary === "it" && cost.lcoeFacility > 0 ? cost.lcoeIT / cost.lcoeFacility : 1;
    const segs = [];
    cost.breakdown.forEach((b, i) => segs.push({
      key: `capex_${i}`, label: `${b.name} (build)`, value: +(b.lcoe * k).toFixed(2),
      colour: T.lcoeSeg.capex[i % T.lcoeSeg.capex.length], kind: "CAPEX",
    }));
    cost.opexBreakdown.forEach((b, i) => segs.push({
      key: `opex_${i}`, label: `${b.name} (run)`, value: +(b.lcoe * k).toFixed(2),
      colour: b.lcoe < 0 ? T.lcoeSeg.credit : T.lcoeSeg.opex[i % T.lcoeSeg.opex.length], kind: b.lcoe < 0 ? "CREDIT" : "OPEX",
    }));
    const row = { name: "LCOE" };
    segs.forEach((sg) => { row[sg.key] = sg.value; });
    const total = Math.round(segs.reduce((a, sg) => a + sg.value, 0) * 100) / 100;
    // A pie cannot draw a negative slice, so credits are listed beside it
    // rather than in it, and the slices are shares of the gross cost.
    const pie = segs.filter((sg) => sg.value > 0.005);
    const credits = segs.filter((sg) => sg.value < -0.005);
    const gross = Math.round(pie.reduce((a, sg) => a + sg.value, 0) * 100) / 100;
    return { segs, rows: [row], total, pie, credits, gross };
  }, [cost, lcoeBoundary, T]);

  const doExport = () => {
    if (!runOut || !cost) return;
    exportWorkbook({
      XLSX, ctx, loc, res, costs, disp, cost, adeq, bom, fin, financials, baseline, stats, mode, aidc,
      aidcDerived, cal, load, price, temp, sens, scenarios, resourceSource, phaseRows,
      firmCapKW: effectiveImportCapKW, autoRank: sweepOut ? sweepOut.feasible.slice(0, 20) : null,
      selfTestOut: runOut.selfTest, diagOut: runOut.diag,
    });
  };

  /* --- The merit order, written out from the current settings -------------- */
  const meritOrderSteps = useMemo(() => {
    const steps = [{ label: "Serve the load from solar and wind — free at the margin, so always first", fixed: true }];
    if (ctx.gridStatus !== "none") {
      steps.push({
        label: res.shave.enabled && res.shave.targetKW > 0
          ? `Import from the grid, but only up to ${fmt(res.shave.targetKW / 1000, 1)} MW so the demand charge stays down`
          : `Import from the grid up to the ${fmt(effectiveImportCapKW / 1000, 1)} MW connection limit`,
        fixed: true,
      });
    }
    const bat = {
      label: res.bess.enabled
        ? `Discharge the battery, never below the ${fmt(res.bess.reserveSocPct, 0)} % held back for an outage`
        : "Battery not installed",
      fixed: false, action: "swap",
    };
    const thermal = {
      label: res.engine.enabled || res.turbine.enabled
        ? `Run generators, each at or above ${fmt(res.engine.minStableLoadPct, 0)} % of its rating`
        : "No generators installed",
      fixed: false, action: "swap",
    };
    if (res.meritOrder === "thermal-first") { steps.push(thermal, bat); } else { steps.push(bat, thermal); }
    if (ctx.gridStatus !== "none" && res.shave.enabled && res.shave.targetKW > 0) {
      steps.push({ label: "If still short, import above the target rather than fail to serve the load", fixed: true });
    }
    steps.push({
      label: res.bess.arbitrage && ctx.gridStatus !== "none"
        ? "Charge the battery from surplus renewables, then from the cheapest hours ahead"
        : "Charge the battery from surplus renewables only",
      fixed: true,
    });
    steps.push({ label: ctx.exportCapKW > 0 ? "Export what is left, then curtail the rest" : "Curtail any renewable surplus that cannot be stored", fixed: true });
    steps.push({ label: "Only as a last resort, shed load by tier, then record it as unserved", fixed: true });
    return steps;
  }, [ctx, res, effectiveImportCapKW]);

  /* Set the operating logic from the stated use case. */
  const applyUseCaseLogic = () => {
    const k = ctx.useCase;
    const thermalFirst = k === "resilience" || k === "access";
    setRes((s2) => ({
      ...s2,
      meritOrder: thermalFirst ? "thermal-first" : "storage-first",
      bess: { ...s2.bess, arbitrage: k === "cost" || k === "decarb",
        reserveSocPct: k === "resilience" ? 50 : k === "deferral" ? 30 : k === "access" ? 20 : 10 },
      lookahead: { ...s2.lookahead, enabled: true },
    }));
  };

  const parasiticKW = parasiticKWval;
  const NeedsRun = () => <NeedsRunCard T={T} onRun={runDispatch} />;

  const saveProject = () => {
    const cfg = buildConfig({ projectName, projectNotes, mode, ctx, locOverride, aidc, loadCfg, char, res,
      costs, fin, sweep, lcoeBoundary, scenarios, csvResult, uploadedResource, uploadedPrice, resourceSource });
    const slug = (projectName.trim() || "microgrid-project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    downloadJSON(`${slug}.json`, cfg);
  };

  /* Which stage the open tab belongs to. The stage colours the tab band and the
     page behind it, so the section you are in is readable at a glance. */
  const stageOf = (i) => {
    const st = TAB_STAGES.find((x) => i >= x.from && i <= x.to) || TAB_STAGES[0];
    return { name: st.name, ...T.stage[st.name] };
  };
  const stage = stageOf(tab);
  const displayProjectName = (projectName || "").trim();

  const axis = { stroke: T.chart.axis, fontSize: 10 };
  const tip = { backgroundColor: T.chart.tipBg, border: `1px solid ${T.chart.tipBorder}`, borderRadius: 4, fontSize: 11 };

  /* ========================================================================= */
  return (
    <ThemeCtx.Provider value={T}>
      <div className={`min-h-screen p-3 ${T.appText} ${stage.page}`}>
        <div className="mx-auto max-w-7xl space-y-3">

          {/* Header */}
          <header className={`flex items-end justify-between gap-3 border-b pb-3 ${T.rule}`}>
            <div className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-2">
                <h1 className={`shrink-0 text-lg font-semibold tracking-tight ${T.title}`}>Microgrid design tool</h1>
                {/* The open project, kept to one line: a long name truncates rather
                    than wrapping the header onto a second row. */}
                <span title={displayProjectName || "No project name set — name it on the Project tab"}
                  className={`min-w-0 max-w-xs truncate rounded border px-2 py-0.5 font-mono text-xs ${displayProjectName ? T.chip : T.chipIdle}`}>
                  {displayProjectName || "unnamed project"}
                </span>
              </div>
              <p className={`truncate text-xs ${T.faint}`}>Pre-feasibility: sizing &amp; LCOE</p>
            </div>
            <div className="flex flex-nowrap items-center gap-2 overflow-x-auto">
              <Seg value={res.dispatchMode === "optimised" ? "optimised" : "merit"}
                onChange={(v) => setRes((s2) => ({ ...s2, dispatchMode: v }))}
                options={[{ value: "merit", label: "Merit order", title: "Merit-order dispatch" },
                          { value: "optimised", label: "Optimised", title: "Optimised dispatch" }]} />
              <button onClick={runDispatch}
                title={!runOut ? "Run the model" : stale ? "Inputs have changed since the last run — run the model again" : "Run the model again"}
                className={`whitespace-nowrap rounded border px-3 py-1.5 text-sm font-medium ${stale ? T.chipAlert : T.btn}`}>
                {!runOut ? "Run model" : stale ? "Re-run model ●" : "Re-run model"}
              </button>
              {/* A search runs for tens of seconds. Say so here as well as on the
                  Auto-size tab, so it is visible from wherever you are. */}
              {sweeping && (
                <span title="A sizing search is running" className={`flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-1 text-xs ${T.chipWarn}`}>
                  <Spinner className="h-3.5 w-3.5" />
                  Sweep in progress · {fmt(sweepElapsedS, 0)} s · {fmt(sweepPct * 100, 0)} %
                </span>
              )}
              <span title={justRan ? `Run complete: 8760 h simulated in ${fmt(dispatchMs, 0)} ms${runOut && runOut.optimised ? ", optimised dispatch" : ", merit-order dispatch"}, all checks passed`
                  : !runOut ? "The model has not been run for these inputs"
                    : stale ? `Last run at ${runOut.at}; inputs have changed since, so the results shown are out of date`
                      : `Last run at ${runOut.at}`}
                className={`whitespace-nowrap rounded px-2 py-1 font-mono text-xs ${justRan ? `${T.chipOk} font-medium` : stale ? T.tone.amber : T.faint}`}>
                {justRan ? `✓ ${fmt(dispatchMs, 0)} ms`
                  : !runOut ? "not run"
                    : stale ? `${runOut.at} · stale`
                      : runOut.at}
              </span>
              <Seg value={themeKey} onChange={setThemeKey}
                options={[{ value: "light", label: "☀", title: "Light theme" }, { value: "dark", label: "☾", title: "Dark theme" }]} />
              <Seg value={density} onChange={setDensity}
                options={[{ value: "essential", label: "Essentials", title: "Essential fields only" },
                          { value: "full", label: "Advanced", title: "All fields, including advanced settings" }]} />
              <Seg value={mode} onChange={setMode}
                options={[{ value: "standard", label: "Standard", title: "Standard project" },
                          { value: "aidc", label: "AIDC", title: "AI data centre project" }]} />
            </div>
          </header>

          {/* Step tabs */}
          <nav className={`rounded border p-1 ${T.panel}`}>
            <div className="flex flex-nowrap items-stretch gap-1 overflow-x-auto">
              {TAB_STAGES.map((st) => {
                const sp = T.stage[st.name];
                return (
                  <div key={st.name} className={`flex flex-nowrap items-center gap-0.5 rounded px-1 py-0.5 ${sp.band}`}>
                    {st.showName && (
                      <span className={`px-1 font-mono text-[10px] uppercase tracking-wide ${sp.label}`} title={`${st.name} stage`}>{st.name}</span>
                    )}
                    {TABS.slice(st.from, st.to + 1).map((t2, k) => {
                      const i = st.from + k;
                      const on = tab === i;
                      return (
                        <button key={t2.n} data-mgt-tab={t2.title} onClick={() => setTab(i)} title={`${t2.title} — ${t2.sub}`}
                          className={`flex items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-1 text-xs ${on ? `${sp.on} font-semibold` : T.tabIdle}`}>
                          <Icon name={t2.icon} className="h-4 w-4" />
                          <span className={on ? "" : "hidden lg:inline"}>{t2.title}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </nav>

          {/* ================= METHOD NOTE =================
              Reached from the footer. A mathematical statement of the dispatch
              optimisation: the objective, the state, the recursion, what the
              method is called, and exactly what the optimality claim covers.
              No code is described here — this page has to survive a refactor. */}
          {showInfo && (<>
            <Panel title="Method note — dispatch optimisation" step="i"
              sub="what is minimised, over what, and by which method"
              right={<button onClick={() => setShowInfo(false)} className={`rounded border px-2 py-1 text-xs ${T.chip}`}>Back to the tool</button>}>
              <p className={`text-xs ${T.title}`}>
                The optimised dispatch minimises the annual variable operating cost of the site by choosing the battery
                charge and discharge schedule for all 8760 hours at once. It is solved by deterministic dynamic programming
                over a discretised state of charge. It is not a simulation, not a heuristic and not a Monte Carlo method.
              </p>
              <p className={`mt-2 text-xs ${T.muted}`}>
                This page states the mathematics. It says nothing about how the tool is written, so it stays true if the
                implementation changes. Every symbol carries its unit.
              </p>
            </Panel>

            <Panel title="The optimisation problem" step="i.1" sub="objective, variables, state and constraints">
              <div className={`rounded border p-2 ${T.soft.cyan}`}>
                <div className={`text-xs font-semibold ${T.head}`}>Objective</div>
                <div className={`mt-1 font-mono text-xs ${T.title}`}>
                  {"minimise   J(b) = Σ over i = 0 … 8759 of [ c_i(need_i) + w · |b_i| · Δt ]        €/yr"}
                </div>
                <div className={`mt-1 text-xs ${T.faint}`}>
                  Δt = 1 h throughout. The tool has no sub-hourly resolution, so energy in kWh and power in kW are
                  numerically the same quantity in every hour and the two are used interchangeably below.
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className={`rounded border p-2 ${T.tile}`}>
                  <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Decision variable</div>
                  <div className={`mt-1 font-mono text-xs ${T.title}`}>{"b_i   battery power in hour i, kW"}</div>
                  <div className={`text-xs ${T.faint}`}>
                    Positive discharging into the site, negative charging. One value per hour, 8760 in total. This is the
                    only quantity the optimiser chooses.
                  </div>
                </div>
                <div className={`rounded border p-2 ${T.tile}`}>
                  <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>State</div>
                  <div className={`mt-1 font-mono text-xs ${T.title}`}>{"s_i   energy stored at the start of hour i, kWh"}</div>
                  <div className={`text-xs ${T.faint}`}>
                    One scalar. This is what makes the problem tractable: the whole history of the year matters to the
                    future only through the energy currently in the battery.
                  </div>
                </div>
              </div>

              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Transition</div>
                <div className={`mt-1 font-mono text-xs ${T.title}`}>
                  {"s_i+1 = s_i − b_i / η        when discharging, b_i ≥ 0"}<br />
                  {"s_i+1 = s_i + |b_i| · η      when charging, b_i < 0"}<br />
                  {"η = √(RTE)                   one-way efficiency, −"}
                </div>
                <div className={`mt-1 text-xs ${T.faint}`}>
                  The round-trip efficiency is split evenly between the two directions, so a full cycle loses RTE exactly
                  once. Charging costs more energy than it stores; discharging delivers less than it removes.
                </div>
              </div>

              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Hourly cost function</div>
                <div className={`mt-1 font-mono text-xs ${T.title}`}>
                  {"need_i = L_i − PV_i − W_i − b_i        kW, the site's net requirement"}
                </div>
                <div className={`mt-2 text-xs ${T.muted}`}>When need_i is positive, it is met in this fixed order:</div>
                <ol className={`mt-1 space-y-0.5 text-xs ${T.title}`}>
                  <li><span className={`font-mono ${T.tone.cyan}`}>1</span> grid import, up to the connection cap, at that hour's price π_i in €/MWh</li>
                  <li><span className={`font-mono ${T.tone.cyan}`}>2</span> engines and turbine, up to their combined rating, at short-run marginal cost m in €/MWh</li>
                  <li><span className={`font-mono ${T.tone.cyan}`}>3</span> whatever is left is unserved, charged at the value of lost load, {fmt(CONSTANTS.VALUE_OF_LOST_LOAD_EUR_PER_MWH, 0)} €/MWh</li>
                </ol>
                <div className={`mt-2 text-xs ${T.muted}`}>When need_i is negative, the surplus is exported up to the export cap at the export price, and the rest is curtailed at zero value.</div>
                <div className={`mt-2 text-xs ${T.faint}`}>
                  c_i is piecewise linear in need_i. It is not necessarily convex: the stack is ordered by supply priority,
                  not sorted by price, so in an hour where the import price exceeds the engine marginal cost the segments
                  are out of order. Dynamic programming does not require convexity, which is one reason it was chosen.
                </div>
              </div>

              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Wear term</div>
                <div className={`mt-1 font-mono text-xs ${T.title}`}>{"w   battery wear cost, €/MWh of throughput"}</div>
                <div className={`text-xs ${T.faint}`}>
                  Charged on every kWh moved in either direction. Without it the optimiser cycles for arbitrarily small
                  gains, because a lossy battery with no cost of use is still worth using whenever prices differ at all.
                  It is a steering cost, deliberately set below full replacement amortisation — capex already pays for the
                  battery once. The Reliability page compares the two figures directly.
                </div>
              </div>

              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Constraints</div>
                <div className={`mt-1 font-mono text-xs ${T.title}`}>
                  {"|b_i| ≤ min(P_rated, E · C-rate)                    kW, power and C-rate limit"}<br />
                  {"SOC_min ≤ 100 · s_i / E ≤ SOC_max                    %, usable window"}<br />
                  {"100 · s_i / E ≥ SOC_reserve                          %, when a reserve is declared"}<br />
                  {"s_8760 ≥ s_0                                         kWh, terminal condition"}<br />
                  {"import_i ≤ cap_i                                     kW, reduced in curtailment hours"}
                </div>
                <div className={`mt-1 text-xs ${T.faint}`}>
                  The terminal condition matters more than it looks. Without it the optimiser ends the year with an empty
                  battery, books the proceeds and reports a cost that cannot be repeated in year two.
                </div>
              </div>
            </Panel>

            <Panel title="The method is deterministic dynamic programming" step="i.2" sub="Bellman recursion on a discretised state">
              <p className={`text-xs ${T.title}`}>
                The state of charge is discretised into N levels evenly spaced across the usable window, N = {CONSTANTS.OPT_SOC_LEVELS} by
                default and settable on the Microgrid page. Level spacing and the reachable move set follow from the
                battery's own ratings:
              </p>
              <div className={`mt-2 rounded border p-2 ${T.soft.cyan}`}>
                <div className={`font-mono text-xs ${T.title}`}>
                  {"Δ = E · (SOC_max − SOC_min) / 100 / (N − 1)      kWh per level"}<br />
                  {"M = floor( min(P_rated, E · C-rate) / Δ )        levels reachable in one hour"}
                </div>
              </div>
              <p className={`mt-3 text-xs ${T.title}`}>
                Let V_i(k) be the least cost of running the site from hour i to the end of the year, given that the battery
                is at level k at the start of hour i. Bellman's principle of optimality gives a backward recursion:
              </p>
              <div className={`mt-2 rounded border p-2 ${T.soft.cyan}`}>
                <div className={`font-mono text-xs ${T.title}`}>
                  {"V_i(k) = min over m ∈ [−M, +M] of [ c_i(k, m) + w · |m| · Δ + V_i+1(k + m) ]"}<br />
                  {"V_8760(k) = 0 if k ≥ k_0,  +∞ otherwise"}
                </div>
                <div className={`mt-1 text-xs ${T.faint}`}>
                  m is the change in level chosen this hour, subject to k + m staying inside the window and above the
                  reserve floor. k_0 is the starting level.
                </div>
              </div>
              <p className={`mt-3 text-xs ${T.muted}`}>
                Solved backwards from hour 8760 to hour 0, then read forwards from k_0 by following the stored minimising
                move. The answer J* = V_0(k_0) is the least cost of the whole year, and the forward walk is the schedule
                that achieves it.
              </p>

              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>An equivalent statement</div>
                <div className={`mt-1 text-xs ${T.title}`}>
                  The same problem is a shortest-path problem on a directed acyclic graph. Nodes are hour-and-level pairs,
                  8760 × N of them. Arcs are the feasible moves out of each node, at most 2M + 1 per node. Arc weight is
                  that hour's cost plus the wear on the move. The recursion above is the standard backward pass for
                  shortest paths on a layered graph. Either description is exact; the graph one is often easier to defend
                  in a meeting.
                </div>
              </div>

              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Cost of the computation</div>
                <div className={`mt-1 font-mono text-xs ${T.title}`}>{"8760 · N · (2M + 1) arc evaluations"}</div>
                <div className={`text-xs ${T.faint}`}>
                  Roughly 8 million for a four-hour battery at N = 41, which is why an optimised run takes seconds rather
                  than milliseconds. The cost is linear in N and in M, not exponential in the number of hours — that is the
                  whole point of the method. A naive search over 8760 hourly decisions is not enumerable at any scale.
                </div>
              </div>
            </Panel>

            <Panel title="This is a standard model, and it is not Monte Carlo" step="i.3" sub="what the method is called, and what it is not">
              <div className={`rounded border p-2 ${T.soft.emerald}`}>
                <div className={`text-xs font-semibold ${T.head}`}>What it is</div>
                <div className={`mt-1 text-xs ${T.title}`}>
                  Deterministic finite-horizon dynamic programming, solved by backward induction over a discretised state.
                  Bellman, 1957. In power systems the same recursion is the classical storage and reservoir scheduling
                  model, and it is the standard textbook treatment of a single storage device with one state variable and a
                  known price series. Nothing here is novel; the model was chosen because it is well understood, auditable
                  by hand on a short horizon, and exact for the discretisation used.
                </div>
              </div>

              <div className={`mt-3 rounded border p-2 ${T.notice.info}`}>
                <div className={`text-xs font-semibold ${T.head}`}>It is not a Monte Carlo method</div>
                <div className="mt-1 text-xs">
                  No random number is drawn anywhere in the optimisation. One deterministic input year produces one
                  schedule, and running the same project twice returns identical figures to the last decimal. A Monte Carlo
                  dispatch would sample many synthetic years of price, resource and load, dispatch each one, and report a
                  distribution of outcomes — a P50 and a P90 rather than a single number. That is a legitimate and
                  different exercise, and this tool does not do it.
                </div>
                <div className="mt-1 text-xs">
                  The closest thing available is on the Reliability page: a single seeded perturbation of the input year,
                  used to price the cost of forecast error. That is a one-draw sensitivity test, not a Monte Carlo
                  distribution, and it should not be quoted as one. Turning it into one would need many draws and a stated
                  correlation structure between price, wind and solar errors, neither of which exists here.
                </div>
              </div>

              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Methods deliberately not used</div>
                <ul className={`mt-1 space-y-1 text-xs ${T.title}`}>
                  <li><span className="font-semibold">Mixed-integer linear programming.</span> The natural formulation for co-optimising storage and engine unit commitment, and what a commercial production-cost model would use. It needs a solver, and a solver is a dependency whose answer cannot be checked by hand. Auditability was preferred.</li>
                  <li><span className="font-semibold">Stochastic dynamic programming and SDDP.</span> Would replace the known price series with a distribution and optimise the expectation. Correct if the object of interest is behaviour under uncertainty; unnecessary for a design-stage comparison against a stated reference year.</li>
                  <li><span className="font-semibold">Model predictive control.</span> A rolling short horizon re-solved every hour, which is what a real plant controller does. The Reliability page approximates the gap between this and perfect foresight instead.</li>
                  <li><span className="font-semibold">Metaheuristics — genetic algorithms, particle swarm, simulated annealing.</span> These return a good schedule with no bound on how far from the best it is. Dynamic programming returns the best one for the discretisation, so there is nothing to gain.</li>
                </ul>
              </div>
            </Panel>

            <Panel title="Demand charges are handled outside the recursion" step="i.4" sub="the one term that is not separable by hour">
              <p className={`text-xs ${T.title}`}>
                Dynamic programming requires the objective to break into a sum of per-hour terms. A capacity charge does
                not: it is billed on each month's highest import, so the cost of an hour depends on every other hour in
                that month.
              </p>
              <div className={`mt-2 rounded border p-2 ${T.soft.cyan}`}>
                <div className={`font-mono text-xs ${T.title}`}>
                  {"D = C · (1/12) · Σ over months of max over hours in month of import_i     €/yr"}
                </div>
                <div className={`mt-1 text-xs ${T.faint}`}>C is the capacity charge in €/kW/yr, taken from the location library.</div>
              </div>
              <p className={`mt-3 text-xs ${T.muted}`}>
                This is handled by an outer search on a single scalar: an import ceiling P̄ applied uniformly across the
                year. For each candidate ceiling the full recursion is solved again with the cap replaced by
                min(cap, P̄), and the total of energy cost, fuel cost and demand charge is compared. The cheapest ceiling
                wins. The uncapped case plus {CONSTANTS.OPT_CEILING_STEPS.length} fixed fractions of the connection cap are
                tried, from {fmt(CONSTANTS.OPT_CEILING_STEPS[0] * 100, 0)} % down to {fmt(CONSTANTS.OPT_CEILING_STEPS[CONSTANTS.OPT_CEILING_STEPS.length - 1] * 100, 0)} %.
              </p>
              <div className={`mt-2 rounded border p-2 ${T.notice.warn}`}>
                <div className="text-xs font-semibold">Known limitation</div>
                <div className="mt-1 text-xs">
                  This is a coarse grid over one number, not an optimisation. A single flat ceiling for the whole year is
                  cruder than a per-month ceiling, the grid steps are {fmt((CONSTANTS.OPT_CEILING_STEPS[0] - CONSTANTS.OPT_CEILING_STEPS[1]) * 100, 0)} percentage points
                  apart, and nothing below {fmt(CONSTANTS.OPT_CEILING_STEPS[CONSTANTS.OPT_CEILING_STEPS.length - 1] * 100, 0)} % of the cap is reachable.
                  If the reported ceiling sits on the bottom of that range, the answer is a corner of the search and not an
                  interior optimum, and it should be read as such.
                </div>
              </div>
            </Panel>

            <Panel title="What is optimised and what is not" step="i.5" sub="the boundary of the claim">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className={`rounded border p-2 ${T.soft.emerald}`}>
                  <div className={`text-xs font-semibold ${T.head}`}>Inside the optimisation</div>
                  <ul className={`mt-1 space-y-1 text-xs ${T.title}`}>
                    <li>The battery schedule for all 8760 hours: when to charge, from grid or from surplus, and when to discharge.</li>
                    <li>Whether to import cheaply now and displace an expensive hour later, against the real hourly price series.</li>
                    <li>Whether a cycle is worth its wear.</li>
                    <li>One flat import ceiling, chosen against the capacity charge.</li>
                  </ul>
                </div>
                <div className={`rounded border p-2 ${T.soft.amber}`}>
                  <div className={`text-xs font-semibold ${T.head}`}>Outside the optimisation</div>
                  <ul className={`mt-1 space-y-1 text-xs ${T.title}`}>
                    <li>Engine unit commitment. Which discrete units run in which hours, with minimum stable load and minimum up and down times, is an integer problem. Engines follow deterministic rules and every engine hour stays inspectable on the Dispatch page.</li>
                    <li>Asset sizing. That is a separate search on the Auto-size page, which calls this optimisation as its inner evaluation.</li>
                    <li>Anything sub-hourly. The model has one time resolution and it is the hour.</li>
                  </ul>
                </div>
              </div>
              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Where the merit order still sits</div>
                <div className={`mt-1 text-xs ${T.title}`}>
                  The optimisation produces a battery schedule and nothing else. That schedule is then executed by the same
                  hour-by-hour plant model the merit order uses, which applies the engine rules, the renewable and
                  curtailment accounting, the load-shedding tiers and every reason code. The two are not alternatives at
                  the engine level: the merit order is how any schedule, optimised or not, becomes a result. It is also the
                  comparator that gives the optimisation a number to beat, and the fast evaluation used when searching
                  hundreds of candidate designs.
                </div>
              </div>
            </Panel>

            <Panel title="The optimality claim, stated precisely" step="i.6" sub="three qualifications, all of them material">
              <p className={`text-xs ${T.title}`}>
                The recursion returns the exact minimum of J over the discretised state space. That statement is true and
                provable. It is narrower than "the optimum" in three ways, and each one should be understood before the
                number is put in front of a client.
              </p>
              <ol className={`mt-2 space-y-2 text-xs ${T.title}`}>
                <li>
                  <span className="font-semibold">Discretisation.</span> The state is N levels, not a continuum. The true
                  continuous optimum is at least as good. This is the only approximation inside the recursion, and it is
                  the one you can test directly: raise N and see whether the answer moves. If it does not, the grid is fine
                  enough.
                </li>
                <li>
                  <span className="font-semibold">Perfect foresight.</span> The whole year's prices, resource and load are
                  known when the schedule is built. No operator has that. The Reliability page prices this explicitly by
                  building an outturn year, optimising it with full knowledge, and then executing the original schedule
                  against it. The difference is the cost of the forecast.
                </li>
                <li>
                  <span className="font-semibold">The objective is a relaxation of the plant.</span> The cost function
                  above omits several things the plant model enforces: engine minimum stable load and commitment timing,
                  battery auxiliary consumption, and any hour in which an engine would run ahead of grid import on economic
                  grounds. When the resulting schedule is executed, the plant can also clip a move that is no longer
                  feasible, and the recursion does not re-plan when that happens.
                </li>
              </ol>
              <div className={`mt-3 rounded border p-2 ${T.notice.info}`}>
                <div className="text-xs font-semibold">How to describe the result</div>
                <div className="mt-1 text-xs">
                  The cheapest battery schedule under a relaxed cost model, with perfect foresight, executed open-loop
                  against the full plant model. Read it as a lower bound on what operations can capture, not as a forecast
                  of what they will.
                </div>
              </div>
            </Panel>

            <Panel title="Checking the result" step="i.7" sub="what must hold, and where to see it">
              <p className={`text-xs ${T.title}`}>Three inequalities have to hold on every project. All three are reported on the Reliability page.</p>
              <div className={`mt-2 rounded border p-2 ${T.soft.cyan}`}>
                <div className={`font-mono text-xs ${T.title}`}>{"relaxed lower bound  ≤  optimised cost  ≤  merit-order cost      €/yr"}</div>
              </div>
              <ul className={`mt-2 space-y-1 text-xs ${T.title}`}>
                <li><span className="font-semibold">The lower bound</span> comes from relaxing everything at once: free lossless unlimited storage, perfect foresight, no engine constraints, energy bought in the cheapest hours the connection allows. No dispatch of any kind can beat it. If the optimised cost ever falls below it, something is wrong by construction and the run should not be used.</li>
                <li><span className="font-semibold">The merit-order cost</span> is the same assets run by fixed priority. The optimisation cannot be worse; if it is, the schedule is being clipped on execution.</li>
                <li><span className="font-semibold">The gap between the two</span> is the most that better dispatch logic could be worth on this design. A small gap says the sizing matters and the control does not.</li>
              </ul>
              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Checks worth running by hand</div>
                <ul className={`mt-1 space-y-1 text-xs ${T.muted}`}>
                  <li>Raise the charge-step count and confirm the answer barely moves. If it moves a lot, the default grid is too coarse for this battery.</li>
                  <li>Re-run with the wear cost at zero and again at full replacement amortisation. The cycle count should fall sharply as wear rises; if it does not, the battery is not being used for arbitrage at all.</li>
                  <li>Set the battery energy to zero. The optimiser has no state to steer and the result must equal the merit order exactly.</li>
                  <li>Compare the reported import ceiling against the connection cap. Equal means the capacity charge never bit.</li>
                </ul>
              </div>
              <div className={`mt-3 flex justify-end`}>
                <button onClick={() => setShowInfo(false)} className={`rounded border px-3 py-1 text-xs ${T.chip}`}>Back to the tool</button>
              </div>
            </Panel>
          </>)}

          {/* HOW TO READ THIS TOOL */}
          {tab === 0 && (
            <Panel title="Conventions" step="—" sub="field colours and marks">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className={`rounded border p-2 ${T.soft.amber}`}>
                  <div className={`mb-1 rounded border px-2 py-1 text-xs ${T.inputSite}`}>input data point</div>
                  <div className={`text-xs ${T.title}`}>Yellow field</div>
                  <div className={`text-xs ${T.faint}`}>Required. This value is specific to the project and must be entered by the user.</div>
                </div>
                <div className={`rounded border p-2 ${T.soft.slate}`}>
                  <div className={`mb-1 rounded border px-2 py-1 text-xs ${T.inputLib}`}>input data point</div>
                  <div className={`text-xs ${T.title}`}>Grey field</div>
                  <div className={`text-xs ${T.faint}`}>Optional. A standard value is already applied. Change it only if the project requires a different one.</div>
                </div>
                <div className={`rounded border p-2 ${T.soft.cyan}`}>
                  <div className={`mb-1 border-l-2 pl-2 text-xs ${T.critRule} ${T.title}`}>input data point</div>
                  <div className={`text-xs ${T.title}`}>Blue left bar</div>
                  <div className={`text-xs ${T.faint}`}>The field can be edited. Fields without the bar are calculated by the tool and are read-only.</div>
                </div>
              </div>
              <div className={`mt-2 text-xs ${T.faint}`}>
                Complete the tabs from left to right, then select <strong>Run model</strong> at the top of the page. This runs the
                dispatch across all 8760 hours of the year.
                Results appear on the Dispatch, Reliability, LCOE and Report tabs. When any input changes the results become
                out of date, and the button turns amber until the model is run again.
              </div>
            </Panel>
          )}

          {/* PROJECT FILE */}
          {tab === 0 && (
            <Panel title="Project file" step="—" sub="save the whole configuration, or reload a saved one"
              right={
                <div className="flex items-center gap-2">
                  <button onClick={saveProject} className={`rounded border px-3 py-1 text-xs ${T.chip}`}>Save project file</button>
                  <button onClick={() => cfgFileRef.current?.click()} className={`rounded border px-3 py-1 text-xs ${T.btn}`}>Load project file</button>
                  <div style={{ width: 250 }}>
                    <Sel value="" prompt="Load an example…" onChange={loadExample}
                      options={Object.entries(EXAMPLE_PROJECTS).map(([k, v]) => ({ value: k, label: v.label }))} />
                  </div>
                  <input ref={cfgFileRef} type="file" accept=".json" className="hidden" onChange={loadProject} />
                </div>
              }>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field tier="critical" label="Project name" source="site" unit="text">
                  <Txt value={projectName} placeholder="name this project" onChange={setProjectName} />
                </Field>
                <Field label="Notes" unit="text">
                  <Txt value={projectNotes} placeholder="revision, client, what changed since the last version" onChange={setProjectNotes} />
                </Field>
                <Field computed label="Source file" unit="—" explain="Where this session was loaded from. Inputs may have changed since.">
                  <Txt value={lastImported || "none — inputs entered by hand"} readOnly />
                </Field>
              </div>
              <p className={`mt-2 text-xs ${T.faint}`}>
                Project JSON file contains every input, every cost override, the saved scenarios and any uploaded load or
                resource series — so a project reopens exactly as it was. Results are not stored; the dispatch and results
                are re-run on load.
              </p>
              {configMsgs && (
                <div className="mt-2 space-y-1">
                  {configMsgs.map((m, i) => (
                    <div key={i} className={`rounded border px-2 py-1 text-xs ${i === 0 ? T.notice.info : T.notice.warn}`}>{m}</div>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {/* 1B. LOCATION AND RESOURCE */}
          {tab === 1 && (
          <Panel title="Location" step="2" sub="sunshine, wind, temperature and land at this site"
            right={
              <div className="flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 font-mono text-xs ${resourceSource.pv === "site" ? T.chipOk : T.chipWarn}`}>
                  {resourceSource.pv === "site" ? "site data" : "library default"} ±{resourceSource.pv === "site" ? CONSTANTS.SITE_YIELD_UNCERTAINTY_PCT : CONSTANTS.LIBRARY_YIELD_UNCERTAINTY_PCT}%
                </span>
                <button onClick={() => downloadCSV("resource-profile-template.csv", buildResourceTemplateCSV(cal))}
                  className={`rounded border px-2 py-1 text-xs ${T.btn}`}>Template</button>
                <button onClick={() => resFileRef.current?.click()} className={`rounded border px-2 py-1 text-xs ${T.btn}`}>Upload PVGIS / TMY / 8760</button>
                <input ref={resFileRef} type="file" accept=".csv,.txt" className="hidden" onChange={onResourceFile} />
              </div>
            }>
            <div className={`mb-1 text-xs uppercase tracking-wide ${T.faint}`}>Site location</div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field tier="critical" label="Country" source="site" unit="—"
                explain="Sets the wholesale price curve, grid fees, fuel prices and grid carbon intensity.">
                <Sel value={ctx.locationId ? loc.country : ""}
                  onChange={(cc) => {
                    const first = Object.entries(LOCATION_LIBRARY).find(([, v]) => v.country === cc);
                    if (first) { setCtx((s2) => ({ ...s2, locationId: first[0] })); setLocOverride({}); setUploadedResource(null); setResourceSource({ pv: "library", temp: "library", note: null }); }
                  }}
                  options={COUNTRY_OPTIONS} />
              </Field>
              <Field tier="critical" label="Site" source="site" unit="—"
                explain="A reference site in that country, or your own with data you enter.">
                <Sel value={ctx.locationId} disabled={!ctx.locationId && !loc.country}
                  onChange={(v) => { setCtx((s2) => ({ ...s2, locationId: v })); setLocOverride({}); setUploadedResource(null); setResourceSource({ pv: "library", temp: "library", note: null }); }}
                  options={Object.entries(LOCATION_LIBRARY).filter(([, v]) => ctx.locationId && v.country === loc.country)
                    .map(([k, v]) => ({ value: k, label: v.label }))
                    .concat(ctx.locationId === "CUSTOM_SITE" ? [] : [{ value: "CUSTOM_SITE", label: "Another site — I will enter its data" }])} />
              </Field>
              {ctx.locationId === "CUSTOM_SITE" && (<>
                <Field tier="critical" label="Site name" source="site" unit="text"
                  explain="A label only — it appears on the report and in the project file.">
                  <Txt value={locOverride.label || ""} placeholder="town or site name"
                    onChange={(v) => setLocOverride((s2) => ({ ...s2, label: v }))} />
                </Field>
                <Field tier="critical" label="Latitude" source="site" unit="°"
                  explain="Positive north, negative south. Sets day length and the sun's height.">
                  <Num value={loc.lat} step={0.1} onChange={(v) => setLocOverride((s2) => ({ ...s2, lat: v }))} />
                </Field>
                </>)}
              </div>

              <div className={`mt-1 mb-1 text-xs uppercase tracking-wide ${T.faint}`}>Solar and wind resource</div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field tier="critical" label="Land available for PV" source="site" unit="ha"
                explain="Caps how much PV can be built. About 12 m² per kWp ground-mounted.">
                <Num value={aidc.landPV_ha} step={0.5} onChange={(v) => setAidc((s2) => ({ ...s2, landPV_ha: v }))} />
              </Field>
              <Field computed label="Maximum PV capacity" unit="MWp"
                explain="Land divided by the area each kWp needs.">
                <Txt value={maxPVfromLandKWp ? `${fmt(maxPVfromLandKWp / 1000, 2)} MWp` : "no limit set"} readOnly />
              </Field>
              <Field tier="critical" label="Solar yield" source="site" unit="kWh/kWp/yr" explain="Yearly output per kWp installed. Moves LCOE more than equipment price." flag={resourceSource.pv === "library" ? "library default" : null}>
                <Num value={loc.specificYield_kWh_per_kWp} step={10} onChange={(v) => setLocOverride((s) => ({ ...s, specificYield_kWh_per_kWp: v }))} />
              </Field>
            </div>

            <Advanced key={`loc-${density}`} title="Advanced — site physics and monthly shapes" count={4} defaultOpen={showAll}>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field label="Latitude" unit="°"><Num value={loc.lat} step={0.01} onChange={(v) => setLocOverride((s) => ({ ...s, lat: v }))} /></Field>
                <Field label="Mean wind speed @100 m" source="library" unit="m/s"><Num value={loc.windMean_m_s_100m} step={0.1} onChange={(v) => setLocOverride((s) => ({ ...s, windMean_m_s_100m: v }))} /></Field>
                <Field label="Weibull shape k" source="library" unit="—"><Num value={loc.weibullK} step={0.1} onChange={(v) => setLocOverride((s) => ({ ...s, weibullK: v }))} /></Field>
                <Field label="Diurnal swing" source="library" unit="°C"><Num value={loc.diurnalSwingC} step={0.5} onChange={(v) => setLocOverride((s) => ({ ...s, diurnalSwingC: v }))} /></Field>
                <Field computed label="Ambient temperature" unit="°C" explain="Plain air temperature, no humidity allowance."><Txt value={fmt(annualMeanT, 1)} readOnly /></Field>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div>
                  <div className={`mb-1 text-xs ${T.faint}`}>Monthly PV yield share — relative, normalised in code</div>
                  <div className="grid grid-cols-6 gap-1">
                    {loc.monthlyYieldShare.map((v, i) => (
                      <div key={i}>
                        <div className={`text-center font-mono text-xs ${T.ghost}`}>{MONTHS[i]}</div>
                        <input type="number" step={0.1} value={v}
                          className={`w-full rounded border px-1 py-0.5 text-center font-mono text-xs ${T.micro}`}
                          onChange={(e) => { const arr = [...loc.monthlyYieldShare]; arr[i] = Number(e.target.value); setLocOverride((s) => ({ ...s, monthlyYieldShare: arr })); }} />
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className={`mb-1 text-xs ${T.faint}`}>Average air temperature by month (°C) — drives panel losses, free cooling hours and engine derating</div>
                  <div className="grid grid-cols-6 gap-1">
                    {loc.tempMeanC.map((v, i) => (
                      <div key={i}>
                        <div className={`text-center font-mono text-xs ${T.ghost}`}>{MONTHS[i]}</div>
                        <input type="number" step={0.5} value={v}
                          className={`w-full rounded border px-1 py-0.5 text-center font-mono text-xs ${T.micro}`}
                          onChange={(e) => { const arr = [...loc.tempMeanC]; arr[i] = Number(e.target.value); setLocOverride((s) => ({ ...s, tempMeanC: arr })); }} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Advanced>

            {resourceSource.note && <div className={`mt-2 rounded border px-2 py-1 text-xs ${T.tile} ${T.muted}`}>{resourceSource.note}</div>}

            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div>
                <div className={`mb-1 text-xs ${T.faint}`}>Monthly solar yield (kWh/kWp) and average air temperature (°C)<br /><span className={T.ghost}>Source: built-in reference library, 2025 edition — typical-year values for this site. Replace with PVGIS or a measured file for a bankable figure.</span></div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={monthlyChart} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid stroke={T.chart.grid} vertical={false} />
                      <XAxis dataKey="m" tick={axis} />
                      <YAxis yAxisId="l" tick={axis} />
                      <YAxis yAxisId="r" orientation="right" tick={axis} />
                      <Tooltip contentStyle={tip} />
                      <Bar yAxisId="l" dataKey="yield" name="kWh/kWp" fill={T.chart.bar2} />
                      <Line yAxisId="r" type="monotone" dataKey="temp" name="°C" stroke={T.chart.load} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 content-start">
                <Stat label="Equivalent full-load hours, PV" value={fmt(loc.specificYield_kWh_per_kWp, 0)} unit="h/yr" tone="amber" />
                <Stat label="Hours ≥ 30 °C" value={fmt(Array.from(temp).filter((t) => t >= 30).length, 0)} unit="h/yr" tone="rose" />
                <Stat label="Hours ≤ 18 °C" value={fmt(Array.from(temp).filter((t) => t <= 18).length, 0)} unit="h/yr" tone="cyan" />
                <Stat label="Yield uncertainty band" value={`±${resourceSource.pv === "site" ? CONSTANTS.SITE_YIELD_UNCERTAINTY_PCT : CONSTANTS.LIBRARY_YIELD_UNCERTAINTY_PCT}`} unit="% P50" />
              </div>
            </div>
          </Panel>
          )}

          {/* ================= GRID ================= */}
          {tab === 2 && (
            <Panel title="Connection" step="3" sub="the connection, the tariff and what power costs here">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field tier="critical" label="Grid status" source="site" unit="—">
                <Sel value={ctx.gridStatus} onChange={(v) => setCtx((s) => ({ ...s, gridStatus: v }))}
                  options={[
                    { value: "none", label: "No connection (off-grid)" },
                    { value: "firm", label: "Firm connection, import cap" },
                    { value: "flexible", label: "Flexible / non-firm (curtailable)" },
                    { value: "phased", label: "Phased connection (stepped caps)" },
                  ]} />
              </Field>
              {ctx.gridStatus !== "none" && ctx.gridStatus !== "phased" && (
                <Field tier="critical" label="Import cap" source="site" unit="kW"><Num value={ctx.importCapKW} step={100} onChange={(v) => setCtx((s) => ({ ...s, importCapKW: v }))} /></Field>
              )}
              {ctx.gridStatus === "phased" && (
                <Field computed tier="critical" label={`Import cap in force, year ${simYear}`} unit="kW" hint="steps are set in the advanced group below">
                  <Txt value={fmt(effectiveImportCapKW, 0)} readOnly />
                </Field>
              )}
              </div>

            <Advanced key={`ctx-${density}`} title="More options — export limit, non-firm terms, capacity steps" count={ctx.gridStatus === "flexible" ? 4 : 2} defaultOpen={showAll}>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <Field label="Export cap" unit="kW" hint="0 = no export allowed"><Num value={ctx.exportCapKW} step={100} onChange={(v) => setCtx((s) => ({ ...s, exportCapKW: v }))} /></Field>
                <Field computed label="Currency" unit="—"><Txt value="EUR" readOnly /></Field>
                {ctx.gridStatus === "flexible" && (<>
                  <Field label="Reduced cap when curtailed" unit="kW"><Num value={ctx.flexReducedCapKW} step={100} onChange={(v) => setCtx((s) => ({ ...s, flexReducedCapKW: v }))} /></Field>
                  <Field label="Hours at reduced cap" unit="% of year"><Num value={ctx.flexPctHours} onChange={(v) => setCtx((s) => ({ ...s, flexPctHours: v }))} /></Field>
                </>)}
                {ctx.gridStatus === "phased" && (
                  <div className="md:col-span-4">
                    <div className={`mb-1 flex items-baseline justify-between`}><span className={`text-xs ${T.advLabel}`}>Grid capacity increases — the year each new capacity becomes available</span><span className={`font-mono text-xs ${T.ghost}`}>year → kW</span></div>
                    <div className="space-y-1">
                      {ctx.phases.map((p, i) => (
                        <div key={i} className="flex gap-2">
                          <Num value={p.year} onChange={(v) => setCtx((s) => { const ph = [...s.phases]; ph[i] = { ...ph[i], year: v }; return { ...s, phases: ph }; })} />
                          <Num value={p.capKW} step={100} onChange={(v) => setCtx((s) => { const ph = [...s.phases]; ph[i] = { ...ph[i], capKW: v }; return { ...s, phases: ph }; })} />
                          <button className={`rounded border px-2 text-xs ${T.btn}`} onClick={() => setCtx((s) => ({ ...s, phases: s.phases.filter((_, j) => j !== i) }))}>−</button>
                        </div>
                      ))}
                      <button className={`rounded border px-2 py-1 text-xs ${T.btn}`}
                        onClick={() => setCtx((s) => ({ ...s, phases: [...s.phases, { year: (s.phases.at(-1)?.year || 0) + 1, capKW: 0 }] }))}>Add a capacity step</button>
                    </div>
                  </div>
                )}
              </div>
            </Advanced>

            </Panel>
          )}

          {/* 1A. AIDC */}
          {tab === 3 && mode === "aidc" && (
            <Panel title="Load — calculated from IT capacity" step="4" sub="sized backwards from a capacity target, not from a measured load">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field tier="critical" label="Target IT capacity, design" source="site" unit="MW IT"><Num value={aidc.targetMWIT} step={0.5} onChange={(v) => setAidc((s) => ({ ...s, targetMWIT: v }))} /></Field>
                <Field tier="critical" label="Cooling type" unit="—">
                  <Sel value={aidc.coolingType} onChange={setCooling} options={Object.entries(CONSTANTS.COOLING).map(([k, v]) => ({ value: k, label: v.label }))} />
                </Field>
                <Field tier="critical" label="Design PUE" unit="—" flag={aidc.pueTouched ? null : "default for this cooling type and climate"}>
                  <Num value={aidc.designPUE} step={0.01} onChange={(v) => setAidc((s) => ({ ...s, designPUE: v, pueTouched: true }))} />
                </Field>
                <Field tier="critical" label="Redundancy level" unit="—">
                  <Sel value={aidc.redundancy} onChange={(v) => setAidc((s) => ({ ...s, redundancy: v }))} options={Object.entries(CONSTANTS.REDUNDANCY).map(([k, v]) => ({ value: k, label: v.label }))} />
                </Field>
                <Field tier="critical" label="Grid supply strategy" unit="—">
                  <Sel value={aidc.gridStrategy} onChange={(v) => setAidc((s) => ({ ...s, gridStrategy: v }))}
                    options={[
                      { value: "grid100", label: "100 % from grid (assets for resilience only)" },
                      { value: "capped", label: "Capped import + on-site balance" },
                      { value: "phased", label: "Phased import caps" },
                      { value: "offgrid", label: "Fully off-grid" },
                    ]} />
                </Field>
                <Field tier="critical" label="Permitted running hours" source="site" unit="h/yr"
                  explain="A permit limit: air-quality or noise consent usually caps annual running hours. Standby-only sites are often limited to 50–200 h."><Num value={aidc.engineHoursLimit} step={50} onChange={(v) => setAidc((s) => ({ ...s, engineHoursLimit: v }))} /></Field>
                <Field tier="critical" label="Collective compute swing" unit="% of IT" hint="drives the fast-response requirement">
                  <Num value={aidc.loadSwingPct} onChange={(v) => setAidc((s) => ({ ...s, loadSwingPct: v }))} />
                </Field>
              </div>

              {/* Ramp is critical */}
              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
                <div className={`border-l-2 pl-2 ${T.critRule}`}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className={`text-xs font-medium ${T.critLabel}`}>Phased fit-out</span>
                    <span className={`font-mono text-xs ${T.ghost}`}>year → MW IT</span>
                  </div>
                  <div className="space-y-1">
                    {aidc.ramp.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Num value={r.year} onChange={(v) => setAidc((s) => { const a = [...s.ramp]; a[i] = { ...a[i], year: v }; return { ...s, ramp: a }; })} />
                        <Num value={r.mwIT} step={0.5} onChange={(v) => setAidc((s) => { const a = [...s.ramp]; a[i] = { ...a[i], mwIT: v }; return { ...s, ramp: a }; })} />
                        <button onClick={() => setAidc((s) => ({ ...s, ramp: s.ramp.filter((_, j) => j !== i) }))} className={`rounded border px-2 text-xs ${T.btn}`}>−</button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <button onClick={() => setAidc((s) => ({ ...s, ramp: [...s.ramp, { year: (s.ramp.at(-1)?.year || 0) + 1, mwIT: s.targetMWIT }] }))}
                        className={`rounded border px-2 py-1 text-xs ${T.btn}`}>Add year</button>
                      <div className="flex-1">
                        <Sel value={String(aidc.analysisYear)} onChange={(v) => setAidc((s) => ({ ...s, analysisYear: Number(v) }))}
                          options={aidc.ramp.map((r) => ({ value: String(r.year), label: `Analyse year ${r.year} — ${r.mwIT} MW IT` }))} />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-2"><Trace lines={aidcTrace} /></div>
              </div>

              <Advanced key={`aidc-${density}`} title="Advanced — thermal design point, UPS, footprints and site limits" count={11} defaultOpen={showAll}>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field label="Air temperature the PUE is quoted at" unit="°C" explain="The hot day the cooling plant is sized for."><Num value={aidc.designAmbientC} onChange={(v) => setAidc((s) => ({ ...s, designAmbientC: v }))} /></Field>
                  <Field label="Free cooling below" unit="°C air temp" explain="Below this, cooling runs on outside air — no chillers."><Num value={aidc.freeCoolingBelowC} onChange={(v) => setAidc((s) => ({ ...s, freeCoolingBelowC: v }))} /></Field>
                  <Field label="IT utilisation" unit="% of installed"><Num value={aidc.itUtilisationPct} onChange={(v) => setAidc((s) => ({ ...s, itUtilisationPct: v }))} /></Field>
                  <Field label="Swing timescale" unit="s"><Num value={aidc.loadSwingSeconds} onChange={(v) => setAidc((s) => ({ ...s, loadSwingSeconds: v }))} /></Field>
                  <Field label="UPS / ride-through" unit="—">
                    <Sel value={aidc.upsPresent ? "yes" : "no"} onChange={(v) => setAidc((s) => ({ ...s, upsPresent: v === "yes" }))} options={[{ value: "yes", label: "Present" }, { value: "no", label: "None" }]} />
                  </Field>
                  <Field label="UPS autonomy" unit="min"><Num value={aidc.upsAutonomyMin} onChange={(v) => setAidc((s) => ({ ...s, upsAutonomyMin: v }))} disabled={!aidc.upsPresent} /></Field>
                  <Field label="Chiller anti-recycle timer" unit="min"><Num value={aidc.antiRecycleMin} onChange={(v) => setAidc((s) => ({ ...s, antiRecycleMin: v }))} /></Field>
                  <Field label="Distribution topology" unit="text" hint="read by the single-point-of-failure check">
                    <Txt value={aidc.topology} onChange={(v) => setAidc((s) => ({ ...s, topology: v }))} />
                  </Field>
                  <Field label="Area per kWp" unit="m²/kWp"><Num value={aidc.pvAreaPerKWp} step={0.5} onChange={(v) => setAidc((s) => ({ ...s, pvAreaPerKWp: v }))} /></Field>
                  <Field label="Footprint for BESS" unit="m²"><Num value={aidc.landBESS_m2} step={100} onChange={(v) => setAidc((s) => ({ ...s, landBESS_m2: v }))} /></Field>
                  <Field label="Footprint for engines" unit="m²"><Num value={aidc.landEngine_m2} step={100} onChange={(v) => setAidc((s) => ({ ...s, landEngine_m2: v }))} /></Field>
                  <Field label="Water for evaporative cooling" unit="—">
                    <Sel value={aidc.waterAvailable ? "yes" : "no"} onChange={(v) => setAidc((s) => ({ ...s, waterAvailable: v === "yes" }))} options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]} />
                  </Field>
                  <Field label="Noise / emissions limit note" unit="text">
                    <Txt value={aidc.noiseLimitNote} placeholder="e.g. 45 dB(A) at boundary, night dispatch blocked" onChange={(v) => setAidc((s) => ({ ...s, noiseLimitNote: v }))} />
                  </Field>
                </div>
              </Advanced>

              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
                <Stat label="IT load" value={fmt(aidcDerived.itKW / 1000, 2)} unit="MW" />
                <Stat label="Cooling at design" value={fmt(aidcDerived.coolingDesignKW / 1000, 2)} unit="MW" tone="cyan" />
                <Stat label="Other overhead" value={fmt(aidcDerived.otherKW / 1000, 2)} unit="MW" />
                <Stat label={`Annualised PUE (design ${fmt(aidc.designPUE, 2)})`} value={fmt(aidcDerived.annualisedPUE, 3)} unit="—" tone="emerald" />
                <Stat label="Load at design ambient" value={fmt(aidcOut.designPeakMW, 2)} unit="MW" tone="amber" />
                <Stat label="Largest load step" value={fmt(aidcOut.stepKW / 1000, 2)} unit="MW" tone="rose" />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-6">
                <Stat label="Firm capacity requirement" value={fmt(aidcOut.firmMW, 2)} unit="MW" tone="amber" />
                <Stat label="Peak, typical year" value={fmt(aidcOut.peakMW, 2)} unit="MW" />
                <Stat label="Free-cooling hours" value={fmt(aidcDerived.freeHours, 0)} unit="h/yr" tone="cyan" />
                <Stat label="PV cap from land" value={fmt(aidcOut.maxKWp / 1000, 2)} unit="MWp" tone="cyan" />
                <Stat label="BESS cap from area" value={fmt(aidcOut.maxBessMW, 1)} unit="MW" tone="violet" />
                <Stat label="Engine cap from area" value={fmt(aidcOut.maxEngineMW, 1)} unit="MW" />
              </div>
              <p className={`mt-2 text-xs ${T.faint}`}>
                IT and cooling are both non-sheddable. Criticality is pre-filled at {fmt(aidcOut.critPct, 0)} % of mean load and can be overridden below.
                €/MW IT capex, LCOE per MWh delivered to IT, time-to-power and the 2N single-point-of-failure check come in Phases 4 and 5.
              </p>
            </Panel>
          )}

          {/* 2. LOAD INPUT */}
          {tab === 3 && mode === "standard" && (
            <Panel title="Load" step="4"
              right={
                <div className="flex items-center gap-2">
                  <button onClick={() => downloadCSV("load-profile-template.csv", buildLoadTemplateCSV(cal))}
                    className={`rounded border px-2 py-1 text-xs ${T.btn}`}>Download template</button>
                  <Seg value={loadCfg.path} onChange={(v) => setLoadCfg((s) => ({ ...s, path: v }))}
                    options={[{ value: "csv", label: "Upload a file" }, { value: "parametric", label: "Build from figures" }]} />
                </div>
              }>
              {loadCfg.path === "csv" ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => fileRef.current?.click()} className={`rounded border px-3 py-1 text-xs ${T.chip}`}>Choose a CSV file</button>
                    <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={onLoadFile} />
                    <button onClick={() => downloadCSV("load-profile-template.csv", buildLoadTemplateCSV(cal))}
                      className={`rounded border px-3 py-1 text-xs ${T.btn}`}>Download template (8760 rows)</button>
                    <span className={`text-xs ${T.faint}`}>Hourly only: 8760 rows of timestamp and load in kW. Sub-hourly files are rejected rather than averaged, because averaging hides the peaks the power and dynamic checks depend on.</span>
                  </div>
                  {csvResult?.error && <div className={`rounded border px-2 py-1 text-xs ${T.notice.fail}`}>{csvResult.error}</div>}
                  {csvResult?.notes && (
                    <div className={`rounded border p-2 ${T.tile}`}>
                      <div className={`mb-1 text-xs uppercase tracking-wide ${T.faint}`}>What was parsed and what was fixed</div>
                      <ul className="space-y-0.5">
                        {csvResult.notes.map((n, i) => <li key={i} className={`font-mono text-xs ${T.muted}`}>· {n}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Field tier="critical" label="Annual energy" source="site" unit="MWh/yr"><Num value={loadCfg.annualEnergyMWh} step={100} onChange={(v) => setLoadCfg((s) => ({ ...s, annualEnergyMWh: v }))} /></Field>
                    <Field tier="critical" label="Peak demand" source="site" unit="kW"><Num value={loadCfg.peakKW} step={50} onChange={(v) => setLoadCfg((s) => ({ ...s, peakKW: v }))} /></Field>
                    <Field tier="critical" label="Base / minimum load" source="site" unit="kW"><Num value={loadCfg.baseKW} step={50} onChange={(v) => setLoadCfg((s) => ({ ...s, baseKW: v }))} /></Field>
                    <Field tier="critical" label="Profile shape" source="site" unit="—">
                      <Sel value={loadCfg.shapeKey} onChange={(v) => setLoadCfg((s) => ({ ...s, shapeKey: v }))} options={Object.entries(LOAD_SHAPES).map(([k, v]) => ({ value: k, label: v.label }))} />
                    </Field>
                  </div>
                  <Advanced key={`load-${density}`} title="Advanced — seasonality, weekend factor and custom hourly shape" count={4} defaultOpen={showAll}>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      <Field label="Seasonal weighting" unit="± %"><Num value={loadCfg.seasonality} onChange={(v) => setLoadCfg((s) => ({ ...s, seasonality: v }))} /></Field>
                      <Field label="Season peaking" unit="—">
                        <Sel value={loadCfg.seasonalPeak} onChange={(v) => setLoadCfg((s) => ({ ...s, seasonalPeak: v }))}
                          options={[{ value: "winter", label: "Winter peaking" }, { value: "summer", label: "Summer peaking" }, { value: "none", label: "No seasonality" }]} />
                      </Field>
                      <Field label="Weekend factor" unit="× weekday"><Num value={loadCfg.weekendFactor} step={0.05} onChange={(v) => setLoadCfg((s) => ({ ...s, weekendFactor: v }))} /></Field>
                      <Field computed label="Shape exponent γ solved" unit="—" hint="load = base + (peak − base) · shape^γ"><Txt value={fmt(synth?.gamma, 3)} readOnly /></Field>
                      {loadCfg.shapeKey === "custom" && (
                        <div className="md:col-span-4">
                          {[["customWeekday", "Weekday"], ["customWeekend", "Weekend"]].map(([key, lbl]) => (
                            <div key={key} className="mb-2">
                              <div className={`mb-0.5 font-mono text-xs ${T.ghost}`}>{lbl} — hourly factors 0–1</div>
                              <div className="grid grid-cols-12 gap-0.5">
                                {loadCfg[key].map((v, i) => (
                                  <input key={i} type="number" step={0.05} min={0} max={1} value={v}
                                    className={`w-full rounded border px-0.5 py-0.5 text-center font-mono text-xs ${T.micro}`}
                                    onChange={(e) => setLoadCfg((s) => { const a = [...s[key]]; a[i] = Number(e.target.value); return { ...s, [key]: a }; })} />
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </Advanced>
                </>
              )}
            </Panel>
          )}

          {/* LOAD CHARACTERISATION */}
          {tab === 3 && (
          <Panel title="Load details — what must stay on, and how fast it changes" step="4" sub="separate inputs — not derivable from the profile">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field tier="critical" label="Critical load (served in island)" source="site" unit="% of load">
                <Num value={char.critPct} onChange={(v) => setChar((s) => ({ ...s, critPct: v, touched: true }))} />
              </Field>
              <Field tier="critical" label="Largest load step" source="site" unit="kW"
                explain="Biggest load that can switch on at once. An hourly profile cannot show it."
                hint={mode === "aidc" ? "pre-filled from the compute swing" : "must be entered — an hourly profile cannot show it"}>
                <Num value={mode === "aidc" && !char.touched ? Math.round(aidcOut.stepKW) : char.stepKW} step={10} onChange={(v) => setChar((s) => ({ ...s, stepKW: v, touched: true }))} />
              </Field>
              {mode !== "aidc" && <Field tier="critical" label="Largest motor start" source="site" unit="kW"
                explain="Motor rating. Starting draws up to 6× this for a few seconds. Industrial sites only — a data centre has no large direct-started motors."><Num value={char.motorKW} step={10} onChange={(v) => setChar((s) => ({ ...s, motorKW: v, touched: true }))} /></Field>}
              <Field computed tier="critical" label="Critical load at peak" unit="kW"><Txt value={fmt(stats.peakKW * char.critPct / 100, 0)} readOnly /></Field>
            </div>

            <Advanced key={`char-${density}`} title="Advanced — shedding tiers, starting method and parasitics" count={4} defaultOpen={showAll}>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field label="Sheddable tier 1" unit="% of load"><Num value={char.shed1Pct} onChange={(v) => setChar((s) => ({ ...s, shed1Pct: v, touched: true }))} /></Field>
                <Field label="Sheddable tier 2" unit="% of load"><Num value={char.shed2Pct} onChange={(v) => setChar((s) => ({ ...s, shed2Pct: v, touched: true }))} /></Field>
                {mode !== "aidc" && <Field label="Motor starting method" unit="—" explain="Direct on line is worst for the generator, a VSD is best.">
                  <Sel value={char.motorMethod} onChange={(v) => setChar((s) => ({ ...s, motorMethod: v }))}
                    options={[{ value: "DOL", label: "Direct on line" }, { value: "SOFT", label: "Soft starter" }, { value: "VSD", label: "VSD" }]} />
                </Field>}
                <Field label="Parasitic / auxiliary load" unit={char.parasiticMode === "pct" ? "% of mean" : "kW"} hint="included in the island load, never omitted">
                  <div className="flex gap-1">
                    <Sel value={char.parasiticMode} onChange={(v) => setChar((s) => ({ ...s, parasiticMode: v }))} options={[{ value: "pct", label: "%" }, { value: "kw", label: "kW" }]} />
                    {char.parasiticMode === "pct"
                      ? <Num value={char.parasiticPct} onChange={(v) => setChar((s) => ({ ...s, parasiticPct: v }))} />
                      : <Num value={char.parasiticKW} step={10} onChange={(v) => setChar((s) => ({ ...s, parasiticKW: v }))} />}
                  </div>
                </Field>
              </div>
            </Advanced>

            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Parasitic load" value={fmt(parasiticKW, 0)} unit="kW" />
              <Stat label="Island load at peak (critical + parasitic)" value={fmt((stats.peakKW * char.critPct / 100 + parasiticKW) / 1000, 2)} unit="MW" tone="amber" />
              <Stat label={`Energy for ${fmt(ctx.autonomyH, 0)} h at critical load`} value={fmt(stats.peakKW * char.critPct / 100 * ctx.autonomyH / 1000, 2)} unit="MWh" tone="violet" />
              <Stat label="Autonomy required" value={fmt(ctx.autonomyH, 0)} unit="h" />
            </div>
          </Panel>

          )}

          {/* LOAD PROFILE */}
          {tab === 3 && (
          <Panel title="Load profile — the shape of the year" step="4"
            right={
              <div className="flex flex-wrap items-center gap-2">
                <Seg value={view.span} onChange={(v) => setView((s) => ({ ...s, span: v }))}
                  options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "year", label: "Year" }]} />
                {view.span !== "year" && (
                  <input type="range" min={0} max={364} value={view.startDay} className="w-40"
                    onChange={(e) => setView((s) => ({ ...s, startDay: Number(e.target.value) }))} />
                )}
                <span className={`font-mono text-xs ${T.faint}`}>{view.span === "year" ? "daily mean" : `from ${dayLabel(view.startDay)}`}</span>
              </div>
            }>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke={T.chart.grid} vertical={false} />
                  <XAxis dataKey="t" tick={axis} minTickGap={40} />
                  <YAxis yAxisId="l" tick={axis} label={{ value: "kW", angle: -90, position: "insideLeft", fill: T.chart.axis, fontSize: 10 }} />
                  <YAxis yAxisId="r" orientation="right" tick={axis} />
                  <Tooltip contentStyle={tip} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area yAxisId="l" type="monotone" dataKey="load" name="Load (kW)" stroke={T.chart.load} fill={T.chart.loadFill} fillOpacity={0.35} />
                  <Line yAxisId="r" type="monotone" dataKey="temp" name="Dry bulb (°C)" stroke={T.chart.temp} dot={false} strokeWidth={1} />
                  <Line yAxisId="r" type="monotone" dataKey="pv" name="PV (kW/kWp)" stroke={T.chart.pv} dot={false} strokeWidth={1} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div>
                <div className={`mb-1 text-xs ${T.faint}`} title="All 8760 hours sorted highest to lowest. A steep left edge means the peak is short and cheap to shave.">Load duration curve — every hour of the year sorted from highest demand to lowest</div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={ldc} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                      <CartesianGrid stroke={T.chart.grid} />
                      <XAxis dataKey="pct" tick={axis} unit="%" />
                      <YAxis tick={axis} />
                      <Tooltip contentStyle={tip} />
                      <ReferenceLine y={stats.meanKW} stroke={T.chart.ref} strokeDasharray="3 3" label={{ value: "mean", fill: T.chart.ref, fontSize: 10 }} />
                      {ctx.gridStatus !== "none" && (
                        <ReferenceLine y={effectiveImportCapKW} stroke={T.chart.refWarn} strokeDasharray="4 2" label={{ value: "import cap", fill: T.chart.refWarn, fontSize: 10 }} />
                      )}
                      <Line type="monotone" dataKey="kW" stroke={T.chart.load} dot={false} strokeWidth={1.5} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div>
                <div className={`mb-1 text-xs ${T.faint}`}>Monthly energy — load (MWh) against PV yield (kWh/kWp)</div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthlyChart} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                      <CartesianGrid stroke={T.chart.grid} vertical={false} />
                      <XAxis dataKey="m" tick={axis} />
                      <YAxis yAxisId="l" tick={axis} />
                      <YAxis yAxisId="r" orientation="right" tick={axis} />
                      <Tooltip contentStyle={tip} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar yAxisId="l" dataKey="load" name="Load (MWh)" fill={T.chart.bar1} />
                      <Bar yAxisId="r" dataKey="yield" name="PV (kWh/kWp)" fill={T.chart.bar2} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
              <Stat label="Mean load" value={fmt(stats.meanKW / 1000, 2)} unit="MW" />
              <Stat label="Peak hour" value={`${dayLabel(cal.doy[stats.peakHour])} ${String(cal.hourOfDay[stats.peakHour]).padStart(2, "0")}h`} unit="" tone="amber" />
              <Stat label="Peak-to-base ratio" value={fmt(stats.peakKW / (stats.minKW || 1), 2)} unit="×" />
              <Stat label="Hours above 90 % peak" value={fmt(Array.from(load).filter((v) => v > 0.9 * stats.peakKW).length, 0)} unit="h/yr" />
              <Stat label="PV yield in use" value={fmt(loc.specificYield_kWh_per_kWp, 0)} unit="kWh/kWp" tone={resourceSource.pv === "site" ? "emerald" : "amber"} />
              <Stat label="Resource source" value={resourceSource.pv === "site" ? "site" : "library"} unit="" tone={resourceSource.pv === "site" ? "emerald" : "amber"} />
            </div>
          </Panel>

          )}

          {/* ================= PHASE 2 — RESOURCES ================= */}
          {tab === 4 && (
          <Panel title="Equipment" step="5" sub="what the dispatch has available"
            right={<span className={`font-mono text-xs ${T.faint}`}>
              {[res.pv.enabled && "PV", res.wind.enabled && "wind", res.bess.enabled && "BESS",
                res.engine.enabled && "engines", res.turbine.enabled && "turbine",
                ctx.gridStatus !== "none" && "grid"].filter(Boolean).join(" · ")}
            </span>}>

            {/* PV */}
            <div className={`rounded border p-2 ${T.tile}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Solar panels (PV)</span>
                <Seg value={res.pv.enabled ? "on" : "off"} onChange={(v) => setRes((s) => ({ ...s, pv: { ...s.pv, enabled: v === "on" } }))}
                  options={[{ value: "on", label: "In" }, { value: "off", label: "Out" }]} />
              </div>
              {res.pv.enabled && (<>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field tier="critical" label="Installed DC capacity" source="site" unit="kWp"
                    flag={maxPVfromLandKWp > 0 && numz(res.pv.kWp) > maxPVfromLandKWp ? `over the ${fmt(maxPVfromLandKWp / 1000, 2)} MWp the land allows` : null}>
                    <Num value={res.pv.kWp} step={100} onChange={(v) => setRes((s) => ({ ...s, pv: { ...s.pv, kWp: v } }))} />
                  </Field>
                  <Field tier="critical" label="DC/AC ratio" unit="kWp/kW" hint={`inverter AC limit ${fmt(pvOut.acLimitKW / 1000, 2)} MW`}>
                    <Num value={res.pv.dcacRatio} step={0.05} onChange={(v) => setRes((s) => ({ ...s, pv: { ...s.pv, dcacRatio: v } }))} />
                  </Field>
                  <Field label="Annual degradation" source="library" unit="%/yr"><Num value={res.pv.degradationPctPerYr} step={0.1} onChange={(v) => setRes((s) => ({ ...s, pv: { ...s.pv, degradationPctPerYr: v } }))} /></Field>

                </div>
                <Advanced key={`pv-${density}`} title="Advanced — soiling, bifacial gain, availability, other losses" count={4} defaultOpen={showAll}>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Field label="Soiling loss" source="library" unit="%"><Num value={res.pv.soilingPct} step={0.5} onChange={(v) => setRes((s) => ({ ...s, pv: { ...s.pv, soilingPct: v } }))} /></Field>
                    <Field label="Bifacial gain" source="library" unit="%"><Num value={res.pv.bifacialGainPct} step={0.5} onChange={(v) => setRes((s) => ({ ...s, pv: { ...s.pv, bifacialGainPct: v } }))} /></Field>
                    <Field label="Availability" source="library" unit="%"><Num value={res.pv.availabilityPct} step={0.5} onChange={(v) => setRes((s) => ({ ...s, pv: { ...s.pv, availabilityPct: v } }))} /></Field>
                    <Field label="Other losses (wiring, mismatch, inverter)" source="library" unit="%"><Num value={res.pv.otherLossesPct} step={0.5} onChange={(v) => setRes((s) => ({ ...s, pv: { ...s.pv, otherLossesPct: v } }))} /></Field>
                  </div>
                </Advanced>
              </>)}
            </div>

            {/* Wind */}
            <div className={`mt-3 rounded border p-2 ${T.tile}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Wind turbines</span>
                <Seg value={res.wind.enabled ? "on" : "off"} onChange={(v) => setRes((s) => ({ ...s, wind: { ...s.wind, enabled: v === "on" } }))}
                  options={[{ value: "on", label: "In" }, { value: "off", label: "Out" }]} />
              </div>
              {res.wind.enabled && (<>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field tier="critical" label="Rated capacity" source="site" unit="kW"><Num value={res.wind.ratedKW} step={100} onChange={(v) => setRes((s) => ({ ...s, wind: { ...s.wind, ratedKW: v } }))} /></Field>
                  <Field tier="critical" label="Hub height" unit="m" hint={`site mean ${fmt(loc.windMean_m_s_100m, 1)} m/s at 100 m`}>
                    <Num value={res.wind.hubHeightM} step={5} onChange={(v) => setRes((s) => ({ ...s, wind: { ...s.wind, hubHeightM: v } }))} />
                  </Field>
                  <Field computed label="Capacity factor achieved" unit="%"><Txt value={fmt(windCF * 100, 1)} readOnly /></Field>
                  <Field computed label="Mean speed at hub" unit="m/s"><Txt value={fmt(windMeanHub, 2)} readOnly /></Field>
                </div>
                <Advanced key={`wind-${density}`} title="Advanced — power curve and availability" count={4} defaultOpen={showAll}>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Field label="Cut-in speed" source="library" unit="m/s"><Num value={res.wind.cutInMs} step={0.5} onChange={(v) => setRes((s) => ({ ...s, wind: { ...s.wind, cutInMs: v } }))} /></Field>
                    <Field label="Rated speed" source="library" unit="m/s"><Num value={res.wind.ratedMs} step={0.5} onChange={(v) => setRes((s) => ({ ...s, wind: { ...s.wind, ratedMs: v } }))} /></Field>
                    <Field label="Cut-out speed" source="library" unit="m/s"><Num value={res.wind.cutOutMs} step={1} onChange={(v) => setRes((s) => ({ ...s, wind: { ...s.wind, cutOutMs: v } }))} /></Field>
                    <Field label="Availability" source="library" unit="%"><Num value={res.wind.availabilityPct} step={0.5} onChange={(v) => setRes((s) => ({ ...s, wind: { ...s.wind, availabilityPct: v } }))} /></Field>
                  </div>
                </Advanced>
              </>)}
            </div>

            {/* BESS */}
            <div className={`mt-3 rounded border p-2 ${T.tile}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Battery storage</span>
                <Seg value={res.bess.enabled ? "on" : "off"} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, enabled: v === "on" } }))}
                  options={[{ value: "on", label: "In" }, { value: "off", label: "Out" }]} />
              </div>
              {res.bess.enabled && (<>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field tier="critical" label="Rated power" source="site" unit="kW"><Num value={res.bess.powerKW} step={100} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, powerKW: v } }))} /></Field>
                  <Field tier="critical" label="Energy capacity" source="site" unit="kWh">
                    <Num value={res.bess.energyKWh} step={100} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, energyKWh: v } }))} />
                  </Field>
                  <Field computed tier="critical" label="Duration at rated power" unit="hours"
                    explain="How long it can hold full output before it is empty.">
                    <Txt value={`${fmt(res.bess.energyKWh / Math.max(1, res.bess.powerKW), 2)} h`} readOnly />
                  </Field>
                  <Field tier="critical" label="Grid-forming capability" unit="—" explain="Grid-forming can hold an island alone. Grid-following cannot.">
                    <Sel value={res.bess.gridForming ? "yes" : "no"} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, gridForming: v === "yes" } }))}
                      options={[{ value: "yes", label: "Grid-forming" }, { value: "no", label: "Grid-following" }]} />
                  </Field>
                </div>
                <Advanced key={`bess-${density}`} title="Advanced — efficiency, SOC window, C-rate, arbitrage" count={6} defaultOpen={showAll}>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Field label="Round-trip efficiency (AC–AC)" source="library" unit="%" explain="Energy out divided by energy in. The rest is lost as heat."><Num value={res.bess.rtePct} step={0.5} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, rtePct: v } }))} /></Field>
                    <Field label="C-rate limit" source="library" unit="1/h" explain="0.5 C empties in 2 hours, 1 C in one hour."><Num value={res.bess.cRate} step={0.05} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, cRate: v } }))} /></Field>
                    <Field label="SoC window, min" source="library" unit="%"><Num value={res.bess.socMinPct} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, socMinPct: v } }))} /></Field>
                    <Field label="SoC window, max" source="library" unit="%"><Num value={res.bess.socMaxPct} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, socMaxPct: v } }))} /></Field>
                    <Field label="Starting SoC" source="library" unit="%"><Num value={res.bess.startSocPct} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, startSocPct: v } }))} /></Field>
                    <Field label="Grid-forming step capability" source="library" unit="% of rating"><Num value={res.bess.gridFormingStepPct} onChange={(v) => setRes((s) => ({ ...s, bess: { ...s.bess, gridFormingStepPct: v } }))} /></Field>
                    <Field computed label="Depth of discharge" unit="%" explain="Comes from the SOC window — not entered separately.">
                      <Txt value={`${fmt(res.bess.socMaxPct - res.bess.socMinPct, 0)} % (from the SOC window)`} readOnly />
                    </Field>
                  </div>
                </Advanced>
              </>)}
            </div>

            {/* Engines */}
            <div className={`mt-3 rounded border p-2 ${T.tile}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Generator sets — diesel or gas engines</span>
                <Seg value={res.engine.enabled ? "on" : "off"} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, enabled: v === "on" } }))}
                  options={[{ value: "on", label: "In" }, { value: "off", label: "Out" }]} />
              </div>
              {res.engine.enabled && (<>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field tier="critical" label="Number of units" source="site" unit="—"><Num value={res.engine.units} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, units: v } }))} /></Field>
                  <Field tier="critical" label="Unit rating" source="site" unit="kW" hint={`fleet ${fmt(res.engine.units * res.engine.unitKW / 1000, 1)} MW`}>
                    <Num value={res.engine.unitKW} step={100} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, unitKW: v } }))} />
                  </Field>
                  <Field tier="critical" label="Minimum stable load" source="library" unit="% of unit" explain="An engine cannot turn down below this. Below it, energy is wasted."
                    hint={`one unit will not run below ${fmt(res.engine.unitKW * res.engine.minStableLoadPct / 100, 0)} kW`}>
                    <Num value={res.engine.minStableLoadPct} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, minStableLoadPct: v } }))} />
                  </Field>
                  <Field tier="critical" label="Fuel" unit="—">
                    <Sel value={res.engine.fuelType} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, fuelType: v, startTimeMin: v === "gas" ? CONSTANTS.ENGINE_START_TIME_MIN_GAS : CONSTANTS.ENGINE_START_TIME_MIN_DIESEL } }))}
                      options={[{ value: "diesel", label: "Diesel" }, { value: "gas", label: "Natural gas" }]} />
                  </Field>
                </div>
                <Advanced key={`eng-${density}`} title="Advanced — step acceptance, start time, minimum up/down, hour budget" count={5} defaultOpen={showAll}>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Field label="Single-step load acceptance" source="library" unit="% of unit"><Num value={res.engine.stepAcceptancePct} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, stepAcceptancePct: v } }))} /></Field>
                    <Field label="Start time" source="library" unit="min"><Num value={res.engine.startTimeMin} step={0.5} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, startTimeMin: v } }))} /></Field>
                    <Field label="Minimum up time" source="library" unit="h"><Num value={res.engine.minUpTimeH} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, minUpTimeH: v } }))} /></Field>
                    <Field label="Minimum down time" source="library" unit="h"><Num value={res.engine.minDownTimeH} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, minDownTimeH: v } }))} /></Field>
                    <Field label="Permitted running hours" unit="h/yr"><Num value={res.engine.annualHourLimit} step={50} onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, annualHourLimit: v } }))} /></Field>
                    <Field tier="critical" label="Economic running" source="site" unit="on / off"
                      explain="Off: the fleet only runs when nothing else can serve the load, which is what a standby set does. On: the fleet is also offered ahead of grid import in hours where its marginal cost is below the import price. Minimum stable load, minimum up and down time and the permitted hours all still apply.">
                      <Sel value={res.engine.economicRun ? "yes" : "no"} prompt={null}
                        onChange={(v) => setRes((s) => ({ ...s, engine: { ...s.engine, economicRun: v === "yes" } }))}
                        options={[{ value: "no", label: "No — adequacy only" }, { value: "yes", label: "Yes — run against the import price" }]} />
                    </Field>
                    <Field computed label="Short-run marginal cost" unit="€/MWh"
                      explain="Fuel at 90 % load plus variable O&M. This is the number compared against the hourly import price when economic running is on.">
                      <Txt value={`${fmt(engineMarginalEURperMWh, 1)} €/MWh`} readOnly />
                    </Field>
                    <Field computed label={res.engine.fuelType === "diesel" ? "Specific consumption at 25/50/75/100 %" : "Electrical efficiency at 25/50/75/100 %"}
                      unit={res.engine.fuelType === "diesel" ? "l/kWh" : "%"}>
                      <Txt value={(res.engine.fuelType === "diesel" ? CONSTANTS.DIESEL_SFC_L_PER_KWH : CONSTANTS.GAS_ENGINE_EFF_PCT).join(" / ")} readOnly />
                    </Field>
                  </div>
                </Advanced>
              </>)}
            </div>

            {/* Turbine */}
            <div className={`mt-3 rounded border p-2 ${T.tile}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Gas turbine — one large machine</span>
                <Seg value={res.turbine.enabled ? "on" : "off"} onChange={(v) => setRes((s) => ({ ...s, turbine: { ...s.turbine, enabled: v === "on" } }))}
                  options={[{ value: "on", label: "In" }, { value: "off", label: "Out" }]} />
              </div>
              {res.turbine.enabled && (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field tier="critical" label="Site-rated output" source="site" unit="kW"
                    explain="Manufacturers quote turbines at ISO conditions: 15 °C at sea level. A real site is hotter and higher, so it produces less. Enter the output expected here, not the catalogue figure."><Num value={res.turbine.ratedKW} step={100} onChange={(v) => setRes((s) => ({ ...s, turbine: { ...s.turbine, ratedKW: v } }))} /></Field>
                  <Field tier="critical" label="Minimum load" unit="% of rating"><Num value={res.turbine.minLoadPct} onChange={(v) => setRes((s) => ({ ...s, turbine: { ...s.turbine, minLoadPct: v } }))} /></Field>
                  <Field label="Minimum up time" source="library" unit="h"><Num value={res.turbine.minUpTimeH} onChange={(v) => setRes((s) => ({ ...s, turbine: { ...s.turbine, minUpTimeH: v } }))} /></Field>
                  <Field computed label="Ambient derating" unit="%/°C above 15" ><Txt value={fmt(CONSTANTS.TURBINE_DERATE_PCT_PER_C_ABOVE_15, 2)} readOnly /></Field>
                </div>
              )}
            </div>

          </Panel>

          )}

          {/* ================= COSTS ================= */}
          {tab === 5 && (
            <Panel title="Costs" step="6" sub="electricity, equipment and fuel prices">
              <div className={`mb-3 rounded border px-2 py-2 text-xs ${T.soft.cyan} ${T.muted}`}>
                Every price the tool uses is on this tab. What the site pays for grid power, what the equipment costs to
                build, and what fuel costs to burn. The LCOE tab turns these into a cost per MWh.
              </div>

              <div className={`rounded border p-2 ${T.tile}`}>
                <div className={`mb-2 text-xs font-semibold uppercase tracking-wide ${T.head}`}>Electricity tariff</div>
                <div className={`mb-2 text-xs ${T.faint}`}>
                  A delivered price has several parts. Enter them separately so the bill can be rebuilt and checked:
                  the wholesale energy price varies hour by hour; network and levy charges are a fixed adder per MWh; the
                  demand charge is billed on the highest power drawn in each month, not on energy at all.
                </div>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field tier="critical" label="Wholesale energy price" source="site" unit="€/MWh"
                    explain="The commodity price alone, before network charges. Sets the yearly average of the hourly curve.">
                    <Num value={loc.importTariff_EUR_per_MWh} onChange={(v) => setLocOverride((s2) => ({ ...s2, importTariff_EUR_per_MWh: v }))} />
                  </Field>
                  <Field tier="critical" label="Network and levy charges" source="site" unit="€/MWh"
                    explain="Everything charged per MWh on top of the commodity price: use-of-system, taxes, certificates.">
                    <Num value={loc.gridFee_EUR_per_MWh} onChange={(v) => setLocOverride((s2) => ({ ...s2, gridFee_EUR_per_MWh: v }))} />
                  </Field>
                  <Field tier="critical" label="Demand charge" source="site" unit="€/kW/yr"
                    explain="Billed on the highest power drawn in each month. This is what peak shaving is worth.">
                    <Num value={loc.capacityCharge_EUR_per_kW_yr} onChange={(v) => setLocOverride((s2) => ({ ...s2, capacityCharge_EUR_per_kW_yr: v }))} />
                  </Field>
                  <Field label="Grid carbon intensity" source="library" unit="gCO₂/kWh"
                    explain="Emissions per MWh imported, used for the avoided-CO₂ figure only.">
                    <Num value={loc.gridCO2_g_per_kWh} onChange={(v) => setLocOverride((s2) => ({ ...s2, gridCO2_g_per_kWh: v }))} />
                  </Field>
                </div>
                <div className={`mt-2 rounded border px-2 py-1 text-xs ${T.notice.info}`}>
                  The tool does not model a full retail tariff. Real supply contracts add balancing, capacity-market and
                  supplier margin terms, and some are indexed rather than passed through. If the delivered price matters to
                  the answer, upload your own hourly series below and set the network adder to zero.
                </div>
              </div>

            <div className={`mt-3 rounded border p-2 ${T.tile}`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Wholesale price profile</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => downloadCSV("price-curve-template.csv", buildPriceTemplateCSV(cal))}
                    className={`rounded border px-2 py-1 text-xs ${T.btn}`}>Download template</button>
                  <button onClick={() => priceFileRef.current?.click()} className={`rounded border px-2 py-1 text-xs ${T.btn}`}>Upload your own price curve</button>
                  <input ref={priceFileRef} type="file" accept=".csv,.txt" className="hidden" onChange={onPriceFile} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field tier="critical" label="Price source" source="site" unit="—">
                  <Sel value={res.tariff.structure} onChange={(v) => setRes((s2) => ({ ...s2, tariff: { ...s2.tariff, structure: v } }))}
                    options={[
                      { value: "market", label: "2025 market prices for this country" },
                      { value: "tou", label: "Fixed contract, peak / off-peak" },
                      { value: "flat", label: "Fixed contract, one price" },
                      ...(uploadedPrice ? [{ value: "uploaded", label: "Your uploaded price curve" }] : []),
                    ]} />
                </Field>
                {res.tariff.structure === "tou" && (
                  <Field label="Peak multiplier" source="library" unit="× base"
                    explain="What a peak-period hour costs, against the base tariff.">
                    <Num value={res.tariff.peakMultiplier} step={0.05}
                      onChange={(v) => setRes((s2) => ({ ...s2, tariff: { ...s2.tariff, peakMultiplier: v } }))} />
                  </Field>
                )}
                {res.tariff.structure === "tou" && (
                  <Field label="Off-peak multiplier" source="library" unit="× base"
                    explain="What an off-peak hour costs, against the base tariff.">
                    <Num value={res.tariff.offPeakMultiplier} step={0.05}
                      onChange={(v) => setRes((s2) => ({ ...s2, tariff: { ...s2.tariff, offPeakMultiplier: v } }))} />
                  </Field>
                )}
                <Stat label="Average price paid" value={fmt(priceStats.mean, 1)} unit="€/MWh" tone="cyan" />
                <Stat label="Cheapest hour" value={fmt(priceStats.lo, 1)} unit="€/MWh" tone="emerald" />
                <Stat label="Most expensive hour" value={fmt(priceStats.hi, 1)} unit="€/MWh" tone="rose" />
              </div>
              <div className={`mt-1 text-xs ${T.faint}`}>
                {res.tariff.structure === "market"
                  ? `Source: ${(MARKET_PRICES_2025[loc.country] || MARKET_PRICES_2025.OTHER).label}, calendar year 2025 — ${(MARKET_PRICES_2025[loc.country] || MARKET_PRICES_2025.OTHER).source}. The shape is a typical 2025 pattern — expensive winter, cheap solar spring, evening peaks — scaled so the yearly average matches the published figure. Grid fees of ${fmt(loc.gridFee_EUR_per_MWh, 0)} €/MWh are added on top.`
                  : res.tariff.structure === "uploaded"
                    ? `Your own hourly prices, with grid fees of ${fmt(loc.gridFee_EUR_per_MWh, 0)} €/MWh added on top.`
                    : "A fixed supply contract rather than market exposure. The battery has far less to earn from price movement on a fixed contract."}
              </div>
              {!MARKET_PRICES_2025[loc.country] && res.tariff.structure === "market" && (
                <div className={`mt-1 rounded border px-2 py-1 text-xs ${T.notice.warn}`}>
                  No published 2025 curve for this country. The shape is modelled from residual demand as usual, but its yearly
                  average is set by the import tariff you enter above rather than by a market operator's figure — so enter that
                  tariff, or upload your own hourly prices.
                </div>
              )}
              {priceNote && <div className={`mt-1 rounded border px-2 py-1 text-xs ${T.notice.info}`}>{priceNote}</div>}
              <div className="mt-2 h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={priceStats.monthly} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                    <CartesianGrid stroke={T.chart.grid} vertical={false} />
                    <XAxis dataKey="m" tick={axis} />
                    <YAxis tick={axis} />
                    <Tooltip contentStyle={tip} />
                    <Bar dataKey="price" name="€/MWh" fill={T.chart.imp} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`mb-2 text-xs font-semibold uppercase tracking-wide ${T.head}`}>Fuel</div>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field tier="critical" label="Diesel price" source="site" unit="€/litre"
                  explain="Delivered price at the site. Drives every diesel running hour.">
                  <Num value={loc.diesel_EUR_per_litre} step={0.05} onChange={(v) => setLocOverride((s2) => ({ ...s2, diesel_EUR_per_litre: v }))} />
                </Field>
                <Field tier="critical" label="Gas price" source="site" unit="€/MWh th"
                  explain="Delivered gas price on a thermal basis, before the engine's efficiency.">
                  <Num value={loc.gas_EUR_per_MWh_th} onChange={(v) => setLocOverride((s2) => ({ ...s2, gas_EUR_per_MWh_th: v }))} />
                </Field>
                </div>
              </div>

              <div className={`mt-3 rounded border p-2 ${T.tile}`}>
                <div className={`mb-2 text-xs font-semibold uppercase tracking-wide ${T.head}`}>Capital cost library</div>
                <div className={`mb-2 text-xs ${T.faint}`}>
                  Budget prices for EU markets. Every one is editable and is flagged “default” until it is changed.
                </div>
              <Advanced key={`costs-${density}`} title="Cost defaults library — every value editable, flagged until overridden"
                count={Object.keys(costs).length} defaultOpen={showAll}>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {COST_FIELDS.map((f) => (
                    <Field key={f.k} label={f.label} unit={f.unit}
                      flag={String(costs[f.k]) === String(CONSTANTS.COST_DEFAULTS[f.k]) ? "default" : null}>
                      {f.k === "AUGMENTATION_YEARS"
                        ? <Txt value={costs[f.k]} onChange={(v) => setCosts((s) => ({ ...s, [f.k]: v }))} />
                        : <Num value={costs[f.k]} step={f.step || 1} onChange={(v) => setCosts((s) => ({ ...s, [f.k]: v }))} />}
                    </Field>
                  ))}
                </div>
                <button onClick={() => setCosts({ ...CONSTANTS.COST_DEFAULTS })} className={`mt-2 rounded border px-2 py-1 text-xs ${T.btn}`}>
                  Reset all to library defaults
                </button>
              </Advanced>
              </div>
            </Panel>
          )}

          {/* ================= MICROGRID — WHAT IT IS FOR, AND THE LOGIC THAT FOLLOWS ========= */}
          {tab === 6 && (
            <Panel title="Microgrid" step="7" sub="what the microgrid is for, and the operating logic that follows"
              right={
                <button onClick={() => { applyUseCaseLogic(); setLogicApplied(true); }}
                  className={`rounded border px-3 py-1 text-xs ${T.chip}`}>Apply the use case</button>
              }>
              <div className={`mb-3 rounded border px-2 py-2 text-xs ${T.soft.cyan} ${T.muted}`}>
                Everything on this tab describes <em>intent</em>: what the microgrid is being built to do. The operating
                logic underneath follows from it. Press <strong>Apply the use case</strong> to set the logic from the intent,
                then override anything you disagree with — the dispatch uses whatever is showing here, not the use case label.
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field tier="critical" label="Use case" source="site" unit="—"
                  explain="Sets the operating logic below.">
                  <Sel value={ctx.useCase} onChange={applyUseCase}
                    options={Object.entries(USE_CASE_FAMILIES).map(([k, v]) => ({ value: k, label: v.label }))} />
                </Field>
                <Field tier="critical" label="Islanding requirement" source="site" unit="—"
                  explain="Planned = you can charge up first. Unplanned = only the reserve is available.">
                  <Sel value={ctx.islanding} onChange={(v) => setCtx((s2) => ({ ...s2, islanding: v }))}
                    options={[{ value: "none", label: "No — grid is always there" },
                      { value: "planned", label: "Yes, with warning (planned)" },
                      { value: "unplanned", label: "Yes, without warning (unplanned)" }]} />
                </Field>
                <Field tier="critical" label="Required autonomy" source="site" unit="hours"
                  explain="How long the critical load must survive with no grid.">
                  <Num value={ctx.autonomyH} onChange={(v) => setCtx((s2) => ({ ...s2, autonomyH: v }))} disabled={ctx.islanding === "none"} />
                </Field>
                <Field tier="critical" label="Peak-shaving target" source="site" unit="kW"
                  explain="Battery holds the meter below this. 0 = no peak shaving.">
                  <Num value={res.shave.enabled ? res.shave.targetKW : 0} step={50}
                    onChange={(v) => setRes((s2) => ({ ...s2, shave: { enabled: v > 0, targetKW: v } }))} />
                </Field>
              </div>

              {res.dispatchMode === "optimised" && (
                <div className={`mt-3 rounded border p-2 ${T.soft.emerald}`}>
                  <div className={`mb-1 text-xs font-semibold uppercase tracking-wide ${T.head}`}>Optimised dispatch</div>
                  <p className={`text-xs ${T.muted}`}>
                    The battery schedule is found by dynamic programming over the whole year: for every hour and every possible
                    state of charge the tool evaluates every move it could make, then keeps the cheapest path through them all.
                    For the given number of charge steps this is the true optimum, not a rule of thumb. It buys at full import
                    when power is cheap or negative, holds it, and displaces the expensive hours — which a fixed order cannot do,
                    because a fixed order only ever looks at the hour in front of it.
                  </p>
                  <p className={`mt-1 text-xs ${T.faint}`}>
                    Generators are still committed by the ordinary rules afterwards, so every engine hour stays auditable —
                    choosing which discrete units run, with minimum up and down times, is an integer problem and is out of scope
                    here. The optimiser also runs a short search over the import ceiling, because demand charges are billed on
                    each month's peak and no hour-by-hour method can see that. A run takes a few seconds rather than milliseconds.
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3">
                    <Field label="Charge steps in the search" source="library" unit="levels"
                      explain={`More steps is finer and slower. 41 is within a fraction of a percent on every case tested. Accepted range ${CONSTANTS.OPT_SOC_LEVELS_MIN}–${CONSTANTS.OPT_SOC_LEVELS_MAX}; values outside it are clamped.`}>
                      <Num value={res.optSocLevels} step={10} min={CONSTANTS.OPT_SOC_LEVELS_MIN} max={CONSTANTS.OPT_SOC_LEVELS_MAX}
                        onChange={(v) => setRes((s2) => ({ ...s2, optSocLevels: v }))} />
                    </Field>
                    <Field label="Battery wear cost" source="library" unit="€/MWh through"
                      explain="Charged on every kWh moved, so the optimiser will not cycle for a gain smaller than the damage.">
                      <Num value={res.optWearCost} step={0.5} onChange={(v) => setRes((s2) => ({ ...s2, optWearCost: v }))} />
                    </Field>
                    <Field computed label="What is optimised" unit="—">
                      <Txt value="the battery only" readOnly />
                    </Field>
                  </div>
                </div>
              )}

              {/* The resulting logic */}
              <div className={`mt-3 rounded border ${T.tile}`} style={{ display: res.dispatchMode === "optimised" ? "none" : undefined }}>
                <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5 ${T.rule}`}>
                  <span className={`text-xs font-semibold uppercase tracking-wide ${T.head}`}>Dispatch logic — merit order</span>
                  <span className={`font-mono text-xs ${T.ghost}`}>
                    {logicApplied ? "set from the use case, editable below" : "current settings"}
                  </span>
                </div>
                <div className="p-2">
                  <ol className="space-y-1">
                    {meritOrderSteps.map((st2, i) => (
                      <li key={i} className={`flex flex-wrap items-center gap-2 rounded px-2 py-1 ${st2.fixed ? T.soft.slate : T.soft.cyan}`}>
                        <span className={`w-5 shrink-0 font-mono text-xs ${T.tone.cyan}`}>{i + 1}</span>
                        <span className={`text-xs ${T.title}`}>{st2.label}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-2">
                          {st2.action === "swap" && (
                            <button onClick={() => setRes((s3) => ({ ...s3, meritOrder: s3.meritOrder === "storage-first" ? "thermal-first" : "storage-first" }))}
                              className={`rounded border px-2 py-0.5 font-mono text-xs ${T.btn}`}
                              title="Swap the battery and the generators in the order">↕ swap</button>
                          )}


                          <span className={`font-mono text-xs ${T.ghost}`}>{st2.fixed ? "fixed" : "editable"}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                  <div className={`mt-2 text-xs ${T.faint}`}>
                    Everything here follows from the settings above. The one thing you can change in the list itself is the
                    order of the battery and the generators — press swap. Renewables always go first because they are free at
                    the margin, and shedding load is always the last resort.
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field tier="critical" label="Dispatch method" source="site" unit="—"
                  explain="Fixed order: simple and readable. Optimised: searches for the cheapest schedule.">
                  <Sel value={res.dispatchMode} onChange={(v) => setRes((s2) => ({ ...s2, dispatchMode: v }))}
                    options={[{ value: "merit", label: "Fixed order — follow the list below" },
                      { value: "optimised", label: "Optimised — find the cheapest schedule" }]} />
                </Field>
                <Field tier="critical" label="Priority after grid import" source="site" unit="—"
                  explain="Battery first saves fuel. Engines first keeps the battery charged.">
                  <Sel value={res.meritOrder} onChange={(v) => setRes((s2) => ({ ...s2, meritOrder: v }))}
                    options={[{ value: "storage-first", label: "Battery first — save fuel" },
                      { value: "thermal-first", label: "Engines first — keep the battery charged" }]} />
                </Field>
                <Field tier="critical" label="Outage reserve" source="site" unit="% SoC"
                  explain="A floor the dispatch may never cross. Higher = safer, earns less.">
                  <Num value={res.bess.reserveSocPct} onChange={(v) => setRes((s2) => ({ ...s2, bess: { ...s2.bess, reserveSocPct: v } }))} disabled={!res.bess.enabled} />
                </Field>
                <Field tier="critical" label="Grid charging" source="site" unit="—"
                  explain="Charge in cheap hours to use later. Needs a variable tariff.">
                  <Sel value={res.bess.arbitrage ? "yes" : "no"} onChange={(v) => setRes((s2) => ({ ...s2, bess: { ...s2.bess, arbitrage: v === "yes" } }))}
                    options={[{ value: "no", label: "No — self-consumption only" }, { value: "yes", label: "Yes — trade on price" }]} />
                </Field>
                <Field tier="critical" label="Look-ahead" source="library" unit="hours"
                  explain="How far ahead the battery rules may look.">
                  <div className="flex gap-1">
                    <Sel value={res.lookahead.enabled ? "on" : "off"} onChange={(v) => setRes((s2) => ({ ...s2, lookahead: { ...s2.lookahead, enabled: v === "on" } }))}
                      options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} />
                    <Num value={res.lookahead.horizonH} step={6} onChange={(v) => setRes((s2) => ({ ...s2, lookahead: { ...s2.lookahead, horizonH: v } }))} />
                  </div>
                </Field>
              </div>

              <Advanced key={`mg-${density}`} title="Advanced — export, sheddable tiers, non-firm connection terms" count={4} defaultOpen={showAll}>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field label="Power allowed back to the grid" unit="kW" explain="Zero means surplus must be stored or thrown away.">
                    <Num value={ctx.exportCapKW} step={100} onChange={(v) => setCtx((s2) => ({ ...s2, exportCapKW: v }))} />
                  </Field>
                  <Field label="Load that may be dropped first" unit="% of load" explain="Lowest priority — dropped first in a shortage.">
                    <Num value={char.shed2Pct} onChange={(v) => setChar((s2) => ({ ...s2, shed2Pct: v, touched: true }))} />
                  </Field>
                  <Field label="Load that may be dropped second" unit="% of load" explain="Dropped only after tier 2 is already off.">
                    <Num value={char.shed1Pct} onChange={(v) => setChar((s2) => ({ ...s2, shed1Pct: v, touched: true }))} />
                  </Field>
                  <Field label="Load that must never be dropped" unit="% of load" explain="Never dropped. Autonomy is measured against this.">
                    <Num value={char.critPct} onChange={(v) => setChar((s2) => ({ ...s2, critPct: v, touched: true }))} />
                  </Field>
                </div>
              </Advanced>
            </Panel>
          )}

          {/* ================= DISPATCH ================= */}
          {tab === 7 && !runOut && <NeedsRun />}
          {tab === 7 && runOut && (
          <Panel title="Dispatch" step="8" sub="hourly operation of every asset"
            right={
              <div className="flex flex-wrap items-center gap-2">
                <DetailToggle value={detail.dispatch} onChange={(v) => setDetail((s2) => ({ ...s2, dispatch: v }))} />
                <Seg value={view.span} onChange={(v) => setView((s) => ({ ...s, span: v }))}
                  options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
                <input type="range" min={0} max={364} value={view.startDay} className="w-40"
                  onChange={(e) => setView((s) => ({ ...s, startDay: Number(e.target.value) }))} />
                <span className={`font-mono text-xs ${T.faint}`}>from {dayLabel(view.startDay)}</span>
              </div>
            }>
            <div className={`mb-2 rounded border px-2 py-1 text-xs ${runOut && runOut.optimised ? T.soft.emerald : T.tile} ${T.muted}`}>
              {runOut && runOut.optimised
                ? `Optimised dispatch. The battery schedule was found by dynamic programming over the whole year — for the given number of charge steps it is the cheapest schedule that exists, not a rule. Generators are still committed by the ordinary rules afterwards. Import ceiling chosen by the search: ${fmt((runOut.disp.optimiserCeilingKW || 0) / 1000, 2)} MW.`
                : "Merit order. Each hour is served in the fixed sequence set on the Microgrid tab, with no view of the hours ahead beyond the look-ahead rules."}
              {res.dispatchMode === "optimised" && runOut && !runOut.optimised
                && " Optimisation is selected but there is no battery to optimise, so the merit order was used."}
            </div>

            {/* Hourly renewable matching — Spanish draft decree for data centres */}
            <div className={`mt-3 rounded border ${T.tile}`}>
              <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5 ${T.rule}`}>
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Hourly renewable matching</span>
                <span className={`font-mono text-xs ${T.ghost}`}>threshold {fmt(hourlyMatch.thresholdPct, 0)} % of each hour</span>
              </div>
              <div className="p-2">
                <div className="mb-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Stat label="Hours meeting the threshold, stored renewables counted"
                    value={fmt(hourlyMatch.pctHoursStore, 1)} unit="% of hours"
                    tone={hourlyMatch.pctHoursStore >= 99.9 ? "emerald" : "amber"} />
                  <Stat label="Hours meeting the threshold, same-hour generation only"
                    value={fmt(hourlyMatch.pctHoursStrict, 1)} unit="% of hours"
                    tone={hourlyMatch.pctHoursStrict >= 99.9 ? "emerald" : "amber"} />
                  <Stat label="Renewable share of consumption, stored counted"
                    value={fmt(hourlyMatch.annualPctStore, 1)} unit="% of MWh" />
                  <Stat label="Worst hour, stored counted"
                    value={fmt(hourlyMatch.worstHourPctStore, 0)} unit="%" />
                </div>
                <p className={`text-xs ${T.faint}`}>
                  Spain's draft royal decree of 25 August 2026 would require data centres of 1 MW or more to back at least
                  80 % of each hour's consumption with renewable generation produced in that same hour, from capacity
                  commissioned no more than 18 months before start-up. The decree is a draft under consultation, not law.
                  It does not settle whether renewable energy stored and discharged later counts, so both readings are shown:
                  the strict one credits only same-hour generation, which no battery can satisfy at night. Charging is
                  attributed to renewable surplus first and to import only for the remainder.
                </p>
              </div>
            </div>

            {/* Dispatch calibration — merit vs optimum, forecast value, battery duty */}
            <div className={`mt-3 rounded border ${T.tile}`}>
              <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5 ${T.rule}`}>
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Dispatch calibration</span>
                <div className="flex items-center gap-2">
                  {calib && <Badge v={(!calib.battery.available || calib.battery.clean) ? "PASS" : "MARGINAL"} />}
                  <button onClick={runCalibration} disabled={!!calibBusy}
                    className={`rounded border px-2 py-1 text-xs ${T.btn} ${calibBusy ? "opacity-60" : ""}`}>
                    {calibBusy ? `Running — ${calibBusy}…` : calib ? "Run the calibration again" : "Run the calibration"}
                  </button>
                </div>
              </div>
              <div className="p-2">
                <div className={`mb-2 text-xs ${T.muted}`}>
                  Three measured answers: what the merit order leaves against the optimiser on this design; how much of that
                  edge survives a realistic forecast, since the optimised schedule is built before the day while the merit
                  order reacts to what actually happens; and whether the battery duty is consistent with the warranty and the
                  wear-cost assumption. Runs the optimiser up to twice — expect a few seconds.
                </div>

                {!calib && !calibBusy && (
                  <div className={`text-xs ${T.faint}`}>Not run yet for this configuration.</div>
                )}

                {calib && (<>
                  {/* 1 — merit against the optimum */}
                  <div className={`mb-1 text-xs font-semibold ${T.head}`}>Merit order against the optimum — variable operating cost, expected year</div>
                  {!calib.gap.available && <div className={`mb-3 text-xs ${T.faint}`}>{calib.gap.reason}</div>}
                  {calib.gap.available && (<>
                    <table className="mb-1 w-full text-left font-mono text-xs">
                      <thead>
                        <tr className={T.faint}>
                          <th className="px-1 py-0.5 font-normal">Cost component, k€/yr</th>
                          <th className="px-1 py-0.5 text-right font-normal">Merit order</th>
                          <th className="px-1 py-0.5 text-right font-normal">Optimised</th>
                          <th className="px-1 py-0.5 text-right font-normal">Difference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[["Import energy", "energy"], ["Engine fuel", "fuel"], ["Demand charge", "demand"], ["Export revenue", "exportRev"], ["Variable operating cost", "total"]].map(([lbl, k]) => {
                          const sign = k === "exportRev" ? -1 : 1;
                          const m = sign * calib.gap.merit[k], o = sign * calib.gap.opt[k];
                          return (
                            <tr key={k} className={`border-b ${T.divide} ${k === "total" ? "font-semibold" : ""}`}>
                              <td className={`px-1 py-0.5 ${k === "total" ? T.title : T.muted}`}>{lbl}{k === "exportRev" ? " (credit)" : ""}</td>
                              <td className="px-1 py-0.5 text-right">{fmt(m / 1000, 1)}</td>
                              <td className="px-1 py-0.5 text-right">{fmt(o / 1000, 1)}</td>
                              <td className={`px-1 py-0.5 text-right ${k === "total" ? (m - o >= 0 ? T.tone.emerald : T.tone.amber) : T.faint}`}>{fmt((m - o) / 1000, 1)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <p className={`mb-3 text-xs ${T.faint}`}>
                      The optimiser saves {fmt(calib.gap.gapEUR / 1000, 1)} k€/yr ({fmt(calib.gap.gapPct, 1)} % of the merit order's
                      variable cost) on this design and year. For scale: the day-spread ceiling on arbitrage is
                      {" "}{fmt(calib.gap.arbitrageCeilingEUR / 1000, 1)} k€/yr, the peak-shaving headroom is worth
                      {" "}{fmt(calib.gap.peakGapEUR / 1000, 1)} k€/yr, and the floor with free lossless storage would be
                      {" "}{fmt(calib.gap.boundEUR / 1000, 1)} k€/yr of supply cost. The optimiser held the import ceiling at
                      {" "}{fmt((calib.gap.optCeilingKW || 0) / 1000, 2)} MW for the demand charge.
                    </p>
                  </>)}

                  {/* 2 — value of the forecast */}
                  <div className={`mb-1 text-xs font-semibold ${T.head}`}>Value of the forecast — the same design on a year that departs from the forecast</div>
                  {!calib.forecast.available && <div className={`mb-3 text-xs ${T.faint}`}>Requires a battery — see above.</div>}
                  {calib.forecast.available && (<>
                    <table className="mb-1 w-full text-left font-mono text-xs">
                      <tbody>
                        <tr className={`border-b ${T.divide}`}>
                          <td className={`px-1 py-0.5 ${T.muted}`}>Optimised with perfect knowledge of the outturn</td>
                          <td className="px-1 py-0.5 text-right">{fmt(calib.forecast.perfect.total / 1000, 1)} k€/yr</td>
                        </tr>
                        <tr className={`border-b ${T.divide}`}>
                          <td className={`px-1 py-0.5 ${T.muted}`}>Day-ahead optimised schedule, executed on the outturn</td>
                          <td className="px-1 py-0.5 text-right">{fmt(calib.forecast.scheduled.total / 1000, 1)} k€/yr</td>
                        </tr>
                        <tr className={`border-b ${T.divide}`}>
                          <td className={`px-1 py-0.5 ${T.muted}`}>Merit order reacting to the outturn</td>
                          <td className="px-1 py-0.5 text-right">{fmt(calib.forecast.meritOut.total / 1000, 1)} k€/yr</td>
                        </tr>
                      </tbody>
                    </table>
                    <p className={`mb-1 text-xs ${T.faint}`}>
                      Forecast error costs the optimiser {fmt(calib.forecast.forecastCostEUR / 1000, 1)} k€/yr against perfect
                      information. The merit order, which needs no forecast, gives up {fmt(calib.forecast.meritRegretEUR / 1000, 1)} k€/yr.
                      {" "}{calib.forecast.optimiserEdgeEUR >= 0
                        ? `The optimised schedule keeps a net edge of ${fmt(calib.forecast.optimiserEdgeEUR / 1000, 1)} k€/yr under this forecast error.`
                        : `Under this forecast error the merit order beats the frozen optimised schedule by ${fmt(-calib.forecast.optimiserEdgeEUR / 1000, 1)} k€/yr — feedback is worth more than foresight here, and the optimised LCOE should be read as an upper bound on what operations can capture.`}
                    </p>
                    <p className={`mb-3 text-xs ${T.ghost}`}>
                      Stress assumptions, one sigma, day-correlated: PV ±{calib.forecast.sigma.pv} %, wind ±{calib.forecast.sigma.wind} %,
                      load ±{calib.forecast.sigma.load} %, price level ±{calib.forecast.sigma.priceDay} % of mean with
                      ±{calib.forecast.sigma.priceHour} % hourly shape error. Fixed seed {calib.forecast.sigma.seed} — the stress is
                      reproducible, not a Monte-Carlo. Constants in CONSTANTS.CALIBRATION.
                    </p>
                  </>)}

                  {/* 3 — battery duty */}
                  <div className={`mb-1 text-xs font-semibold ${T.head}`}>Battery duty against warranty and wear assumptions</div>
                  {!calib.battery.available && <div className={`text-xs ${T.faint}`}>{calib.battery.reason}</div>}
                  {calib.battery.available && (<>
                    <div className="mb-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                      <Stat label="Equivalent full cycles" value={fmt(calib.battery.efc, 0)} unit="/yr" tone="cyan" />
                      <Stat label="Warranty cycle budget" value={fmt(calib.battery.budgetCyclesPerYr, 0)} unit="/yr" />
                      <Stat label="Discharge throughput" value={fmt(calib.battery.dischargeMWh, 0)} unit="MWh/yr" />
                      <Stat label="Cycle allowance lasts" value={isFinite(calib.battery.yearsToExhaust) ? fmt(calib.battery.yearsToExhaust, 1) : "—"} unit="yr" tone={calib.battery.yearsToExhaust < CONSTANTS.CALIBRATION.WARRANTY_YEARS ? "amber" : "emerald"} />
                    </div>
                    <table className="w-full text-left font-mono text-xs">
                      <tbody>
                        {calib.battery.findings.map((f, i) => (
                          <tr key={i} className={`border-b ${T.divide}`}>
                            <td className="px-1 py-0.5 w-12"><Badge v={f.good ? "PASS" : "MARGINAL"} /></td>
                            <td className={`px-1 py-0.5 ${T.title}`}>{f.name}</td>
                            <td className={`px-1 py-0.5 text-right ${f.good ? T.tone.emerald : T.tone.amber}`}>{f.value}</td>
                            <td className={`px-1 py-0.5 ${T.faint}`}>{f.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>)}
                </>)}
              </div>
            </div>


            {detail.dispatch === "detail" && (
            <div className={`mb-2 rounded border px-2 py-1 text-xs ${T.tile} ${T.muted}`}>
              Order every hour: renewables → grid import to the cap → battery above the reserve → engines at or above minimum
              stable load → turbine → charge from surplus, then from cheap grid hours → export or curtail → shed by tier, then unserved.
              The reason code names the highest-severity constraint that bound the hour.
            </div>
            )}

            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={dispSeries} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke={T.chart.grid} vertical={false} />
                  <XAxis dataKey="t" tick={axis} minTickGap={40} />
                  <YAxis yAxisId="l" tick={axis} label={{ value: "kW", angle: -90, position: "insideLeft", fill: T.chart.axis, fontSize: 10 }} />
                  <YAxis yAxisId="r" orientation="right" tick={axis} domain={[0, 100]} label={{ value: "SOC %", angle: 90, position: "insideRight", fill: T.chart.axis, fontSize: 10 }} />
                  <Tooltip contentStyle={tip} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {res.pv.enabled && <Area yAxisId="l" type="step" stackId="s" dataKey="pv" name="Solar PV" stroke={T.chart.temp} fill={T.chart.temp} fillOpacity={0.55} />}
                  {res.wind.enabled && <Area yAxisId="l" type="step" stackId="s" dataKey="wind" name="Wind" stroke={T.chart.wind} fill={T.chart.wind} fillOpacity={0.55} />}
                  {gridForBom.enabled && <Area yAxisId="l" type="step" stackId="s" dataKey="imp" name="Grid import" stroke={T.chart.imp} fill={T.chart.imp} fillOpacity={0.45} />}
                  {res.bess.enabled && <Area yAxisId="l" type="step" stackId="s" dataKey="bessDis" name="Battery" stroke={T.chart.bessC} fill={T.chart.bessC} fillOpacity={0.55} />}
                  {res.engine.enabled && <Area yAxisId="l" type="step" stackId="s" dataKey="engine" name="Generators" stroke={T.chart.engineC} fill={T.chart.engineC} fillOpacity={0.55} />}
                  {res.turbine.enabled && <Area yAxisId="l" type="step" stackId="s" dataKey="turbine" name="Turbine" stroke={T.chart.turbineC} fill={T.chart.turbineC} fillOpacity={0.55} />}
                  {disp.summary.unservedMWh > 0 && <Area yAxisId="l" type="step" stackId="s" dataKey="unserved" name="Not served" stroke={T.chart.unservedC} fill={T.chart.unservedC} fillOpacity={0.8} />}
                  <Line yAxisId="l" type="step" dataKey="load" name="Load" stroke={T.chart.load} dot={false} strokeWidth={1.5} />
                  {res.bess.enabled && <Line yAxisId="r" type="monotone" dataKey="soc" name="Battery charge (%)" stroke={T.chart.socC} dot={false} strokeWidth={1} strokeDasharray="3 2" />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
              <Stat label="Renewable fraction" value={fmt(disp.summary.renewableFraction * 100, 1)} unit="%" tone="emerald" />
              <Stat label="Grid import" value={fmt(disp.summary.importMWh, 0)} unit="MWh/yr" tone="cyan" />
              <Stat label="Engine energy" value={fmt(disp.summary.engineMWh + disp.summary.turbineMWh, 0)} unit="MWh/yr" tone="amber" />
              <Stat label="Engine running hours" value={fmt(disp.summary.engineHours, 0)} unit="h/yr" tone={disp.summary.engineHours > res.engine.annualHourLimit ? "rose" : "amber"} />
              <Stat label="Fuel" value={res.engine.fuelType === "diesel" ? fmt(disp.summary.fuelLitres / 1000, 0) : fmt(disp.summary.fuelMWhTh, 0)}
                unit={res.engine.fuelType === "diesel" ? "kl/yr" : "MWh th/yr"} />
              <Stat label="Unserved energy" value={fmt(disp.summary.unservedMWh, 2)} unit="MWh/yr" tone={disp.summary.unservedMWh > 0 ? "rose" : "emerald"} />
              <Stat label="Renewable curtailed" value={fmt(disp.summary.curtailRenewMWh, 0)} unit="MWh/yr" tone="rose" />
              <Stat label="Curtailment rate" value={fmt(disp.summary.curtailmentRate * 100, 1)} unit="% of gen" />
              <Stat label="Engine surplus dumped" value={fmt(disp.summary.curtailEngineMWh, 0)} unit="MWh/yr" tone="rose" />
              <Stat label="Battery cycles" value={fmt(disp.summary.equivalentFullCycles, 0)} unit="EFC/yr" tone="violet" />
              <Stat label="Minimum SoC reached" value={fmt(disp.summary.minSoc, 0)} unit="%" tone="violet" />
              <Stat label="Peak import (annual)" value={fmt(disp.summary.peakImportKW / 1000, 2)} unit="MW" tone="cyan" />
              <Stat label="PV inverter clipping" value={fmt(pvOut.clippedHours, 0)} unit="h/yr" tone={pvOut.clippedHours > 500 ? "amber" : "slate"} />
              <Stat label="Billed peak (mean of 12 monthly)" value={fmt(disp.summary.meanMonthlyPeakKW / 1000, 2)} unit="MW" tone="cyan" />
            </div>

            {detail.dispatch === "detail" && (<>
            {/* Engine self-test — reliability shown, not asserted */}
            <div className={`mt-3 rounded border ${T.tile}`}>
              <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5 ${T.rule}`}>
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Engine self-test</span>
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-xs ${T.faint}`}>
                    8760 h in {fmt(dispatchMs, 1)} ms · checks in {fmt((runOut.msWithTest || 0) - dispatchMs, 1)} ms
                  </span>
                  <Badge v={runOut.selfTest.failed === 0 ? "PASS" : "FAIL"} />
                  <span className={`font-mono text-xs ${runOut.selfTest.failed ? T.tone.rose : T.tone.emerald}`}>
                    {runOut.selfTest.passed}/{runOut.selfTest.total}
                  </span>
                  <Seg value={selfTestOpen ? "open" : "closed"} onChange={(v) => setSelfTestOpen(v === "open")}
                    options={[{ value: "closed", label: "Reduce" }, { value: "open", label: "Expand" }]} />
                </div>
              </div>
              {selfTestOpen && (
                <div className="p-2">
                  <div className={`mb-2 text-xs ${T.muted}`}>
                    These checks re-derive every physical constraint from the stored hourly arrays, not from the code that
                    produced them — so an error in the dispatch cannot hide behind them. Any failure names the hour.
                  </div>
                  <table className="w-full text-left font-mono text-xs">
                    <tbody>
                      {runOut.selfTest.checks.map((c, i) => (
                        <tr key={i} className={`border-b ${T.divide}`}>
                          <td className="px-1 py-0.5 w-12"><Badge v={c.pass ? "PASS" : "FAIL"} /></td>
                          <td className={`px-1 py-0.5 ${T.title}`}>{c.name}</td>
                          <td className={`px-1 py-0.5 ${T.faint}`}>{c.detail}</td>
                          <td className={`px-1 py-0.5 text-right ${c.pass ? T.tone.emerald : T.tone.rose}`}>{c.worst}</td>
                          <td className={`px-1 py-0.5 text-right ${T.ghost}`}>{c.pass ? "" : `hour ${c.worstHour} · ${c.fails} h`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Dispatch quality — how much room is left */}
            <div className={`mt-3 rounded border ${T.tile}`}>
              <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5 ${T.rule}`}>
                <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Dispatch quality</span>
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-xs ${T.ghost}`}>
                    {res.lookahead.enabled ? `${res.lookahead.horizonH} h look-ahead` : "no look-ahead"} · set on the Microgrid tab
                  </span>
                  <Badge v={runOut.diag.clean ? "PASS" : "MARGINAL"} />
                </div>
              </div>
              <div className="p-2">
                <div className={`mb-2 text-xs ${T.muted}`}>
                  Merit order is myopic by construction: it cannot know that a bigger peak or a cheaper hour is coming.
                  Two look-ahead rules give it a finite horizon without making it an optimiser — the battery levels the peaks
                  across the horizon rather than collapsing into the first one, and it will not fill itself from the grid with
                  energy the forecast surplus is about to supply for nothing. Each leaves its own reason code.
                  These tests then measure what myopia still costs, using only what actually happened.
                </div>
                <table className="w-full text-left font-mono text-xs">
                  <tbody>
                    {runOut.diag.findings.map((f, i) => (
                      <tr key={i} className={`border-b ${T.divide}`}>
                        <td className="px-1 py-0.5 w-12"><Badge v={f.good ? "PASS" : "MARGINAL"} /></td>
                        <td className={`px-1 py-0.5 ${T.title}`}>{f.name}</td>
                        <td className={`px-1 py-0.5 text-right ${f.good ? T.tone.emerald : T.tone.amber}`}>{f.value}</td>
                        <td className={`px-1 py-0.5 ${T.faint}`}>{f.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Stat label="Peak import, with look-ahead" value={fmt(runOut.diag.achievedPeakKW / 1000, 3)} unit="MW" tone="cyan" />
                  <Stat label="Peak import, merit order only" value={fmt(runOut.myopicPeakKW / 1000, 3)} unit="MW" />
                  <Stat label="Best any policy could reach" value={fmt(runOut.diag.achievablePeakKW / 1000, 3)} unit="MW" tone="emerald" />
                  <Stat label="Value still on the table" value={fmt(runOut.diag.peakGapEUR / 1000, 1)} unit="k€/yr" tone={runOut.diag.peakGapEUR > 1000 ? "amber" : "emerald"} />
                </div>
                <p className={`mt-2 text-xs ${T.faint}`}>
                  The floor is a water-fill bound: the lowest peak at which every day's energy above that level still fits in
                  the usable capacity and within rated power. No policy — rule-based, MILP or human — can beat it. The gap to it
                  is the most that a full optimiser could be worth on this design, priced at the site capacity charge of
                  {" "}{fmt(loc.capacityCharge_EUR_per_kW_yr, 0)} €/kW/yr. The look-ahead uses a perfect forecast of its own
                  horizon; a real plant forecasts imperfectly and will do somewhat worse.
                </p>
              </div>
            </div>

            {/* Why each hour turned out that way */}
            <div className="mt-3">
              <div className={`mb-1 text-xs ${T.faint}`}>
                Binding constraint by hour — select a constraint to filter the table below.
                Greyed-out entries never happened in this design, which is itself informative.
              </div>
              <div className="space-y-1">
                {REASON_GROUPS.map((grp) => {
                  const items = REASON_CODES.map((c, i) => ({ c, i, n: disp.summary.reasonCount[i] }))
                    .filter((x) => REASON_INFO[x.c].group === grp);
                  if (!items.length) return null;
                  const tone = grp === "Normal" ? T.muted : grp === "Constrained" ? T.tone.cyan : grp === "Waste" ? T.tone.amber : T.tone.rose;
                  return (
                    <div key={grp} className="flex flex-wrap items-baseline gap-1">
                      <span className={`w-24 shrink-0 text-xs uppercase tracking-wide ${tone}`}>{grp}</span>
                      {items.map((x) => (
                        <button key={x.c} title={REASON_INFO[x.c].hint} disabled={x.n === 0}
                          onClick={() => setReasonFilter(reasonFilter === x.i ? -1 : x.i)}
                          className={`rounded border px-2 py-0.5 text-xs ${reasonFilter === x.i ? T.btnOn : x.n === 0 ? T.chipIdle : T.btn}`}>
                          {REASON_INFO[x.c].label}
                          <span className={`ml-1.5 font-mono ${reasonFilter === x.i ? "" : T.ghost}`}>{x.n} h</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
              <div className={`mt-1 text-xs ${T.faint}`}>
                Normal means nothing was limiting. Constrained means something ran out — that is the finding worth reading.
                Waste means energy was thrown away. Failure means load was not served.
                {reasonFilter >= 0 && <> Filtering on <span className={T.tone.cyan}>{REASON_INFO[REASON_CODES[reasonFilter]].label}</span> — {REASON_INFO[REASON_CODES[reasonFilter]].hint}. <button onClick={() => setReasonFilter(-1)} className={`rounded border px-1.5 ${T.btn}`}>clear</button></>}
              </div>
            </div>

            </>)}

            {/* Hourly audit table */}
            {detail.dispatch === "detail" && (
            <div className="mt-3">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <span className={`text-xs ${T.faint}`}>
                  Hourly table — {tableRows.length} row{tableRows.length === 1 ? "" : "s"}
                  {reasonFilter >= 0 ? ` matching ${REASON_CODES[reasonFilter]} across the whole year` : ` in the selected window`}
                </span>
                <span className={`font-mono text-xs ${T.ghost}`}>kW unless stated</span>
              </div>
              <div className={`max-h-96 overflow-auto rounded border ${T.tile}`}>
                <table className="w-full border-collapse text-right font-mono text-xs">
                  <thead className={`sticky top-0 ${T.panel}`}>
                    <tr className={`border-b ${T.rule}`}>
                      {["h", "date", "load", "PV", "wind", "import", "BESS", "SOC %", "engine", "on", "turbine", "aux", "curtail", "shed", "unserved", "reason"].map((h) => (
                        <th key={h} className={`px-1.5 py-1 ${T.faint} ${h === "date" || h === "reason" ? "text-left" : ""}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={r.i} className={`border-b ${T.divide} ${r.unserved > 0 ? T.notice.fail : ""}`}>
                        <td className={`px-1.5 py-0.5 ${T.ghost}`}>{r.i}</td>
                        <td className={`px-1.5 py-0.5 text-left ${T.muted}`}>{r.date}</td>
                        <td className="px-1.5 py-0.5">{fmt(r.load, 0)}</td>
                        <td className={`px-1.5 py-0.5 ${T.tone.amber}`}>{fmt(r.pv, 0)}</td>
                        <td className="px-1.5 py-0.5">{fmt(r.wind, 0)}</td>
                        <td className={`px-1.5 py-0.5 ${T.tone.cyan}`}>{fmt(r.imp, 0)}</td>
                        <td className={`px-1.5 py-0.5 ${T.tone.violet}`}>{fmt(r.bess, 0)}</td>
                        <td className="px-1.5 py-0.5">{fmt(r.soc, 0)}</td>
                        <td className="px-1.5 py-0.5">{fmt(r.engine, 0)}</td>
                        <td className={`px-1.5 py-0.5 ${T.ghost}`}>{r.on}</td>
                        <td className="px-1.5 py-0.5">{fmt(r.turbine, 0)}</td>
                        <td className={`px-1.5 py-0.5 ${T.ghost}`}>{fmt(r.aux, 0)}</td>
                        <td className="px-1.5 py-0.5">{fmt(r.curtail, 0)}</td>
                        <td className="px-1.5 py-0.5">{fmt(r.shed, 0)}</td>
                        <td className={`px-1.5 py-0.5 ${r.unserved > 0 ? "" : T.ghost}`}>{fmt(r.unserved, 0)}</td>
                        <td className={`px-1.5 py-0.5 text-left ${T.tone.cyan}`} title={r.code}>{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={`mt-1 text-xs ${T.faint}`}>
                Energy balance check: load {fmt(disp.summary.loadMWh, 0)} MWh = PV {fmt(disp.summary.pvMWh - disp.summary.curtailRenewMWh - disp.summary.exportMWh, 0)}
                {" "}+ wind + import {fmt(disp.summary.importMWh, 0)} + engines {fmt(disp.summary.engineMWh + disp.summary.turbineMWh, 0)}
                {" "}± storage, less {fmt(disp.summary.unservedMWh + disp.summary.shed1MWh + disp.summary.shed2MWh, 1)} MWh not served.
                Dispatch runs in {fmt(dispatchMs, 0)} ms.
              </p>
            </div>
            )}
          </Panel>
          )}

          {/* ================= PHASE 3 — ADEQUACY ================= */}
          {tab === 8 && !runOut && (<>
            <NeedsRun />
            <Panel title="Checks" step="9b" sub="warnings and notes, never blockers"
              right={
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 font-mono text-xs ${notices.some((n) => n.level === "warn") ? T.chipWarn : T.chipOk}`}>
                    {notices.filter((n) => n.level === "warn").length} checks
                  </span>
                  <span className={`rounded border px-2 py-0.5 font-mono text-xs ${T.chipIdle}`}>
                    {notices.filter((n) => n.level === "info").length} notes
                  </span>
                  <Seg value={noticesOpen ? "open" : "closed"} onChange={(v) => setNoticesOpen(v === "open")}
                    options={[{ value: "closed", label: "Reduce" }, { value: "open", label: "Expand" }]} />
                </div>
              }>
              {notices.length === 0 ? (
                <div className={`rounded border px-2 py-2 text-xs ${T.notice.info}`}>Nothing flagged for the current inputs.</div>
              ) : noticesOpen ? (
                <Notices items={notices} />
              ) : (
                <ul className="space-y-0.5">
                  {notices.map((n, i) => (
                    <li key={i} className={`truncate font-mono text-xs ${n.level === "warn" ? T.tone.amber : T.muted}`}>
                      <span className="uppercase mr-2">{n.level === "warn" ? "check" : "note"}</span>{n.text}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>)}
          {tab === 8 && runOut && (<>
            <Panel title="Reliability" step="9" sub="adequacy assessment"
              right={<DetailToggle value={detail.reliability} onChange={(v) => setDetail((s2) => ({ ...s2, reliability: v }))} />}>
              <div className={`mb-3 rounded border px-2 py-1 text-xs ${T.tile} ${T.muted}`}>
                A design that fails dynamic adequacy is not viable because energy and power pass. Each check below shows the
                number that governs it. Dynamic adequacy is assessed in island mode, since that is when the microgrid must
                survive a step on its own inertia.
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {/* Energy */}
                <div className={`rounded border ${T.tile}`}>
                  <div className={`flex items-center justify-between border-b px-2 py-1.5 ${T.rule}`}>
                    <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Energy adequacy</span>
                    <Badge v={adeq.energy.verdict} />
                  </div>
                  <div className="p-2">
                    <div className={`mb-2 font-mono text-xs ${T.tone.cyan}`}>{adeq.energy.governing}</div>
                    {fixes && fixes.energy.length > 0 && (
                      <div className={`mb-2 rounded border p-2 ${T.notice.warn}`}>
                        <div className="mb-1 text-xs font-semibold uppercase tracking-wide">To make this pass</div>
                        <ul className="space-y-1">
                          {fixes.energy.map((f, k) => <li key={k} className="text-xs">· {f}</li>)}
                        </ul>
                      </div>
                    )}
                    {detail.reliability === "detail" && <Trace lines={[
                      { label: "Unserved energy", expr: `over 8760 h, ${fmt(adeq.energy.unservedPct, 3)} % of annual load`, result: `${fmt(adeq.energy.unservedMWh, 2)} MWh/yr` },
                      { label: "Load shed", expr: "tier 1 + tier 2 curtailed by the dispatch", result: `${fmt(adeq.energy.shedMWh, 2)} MWh/yr` },
                      { label: "Island load", expr: `${fmt(char.critPct, 0)} % critical of ${fmt(stats.peakKW / 1000, 2)} MW peak + parasitics`, result: `${fmt(adeq.energy.islandLoadKW / 1000, 2)} MW` },
                      { label: "Stored energy usable", expr: ctx.islanding === "planned" ? "planned island — full SOC window, charged in advance" : "unplanned island — only what the reserve holds", result: `${fmt(adeq.energy.islandKWh / 1000, 2)} MWh` },
                      { label: "Autonomy achieved", expr: `stored energy ÷ island load, against ${fmt(adeq.energy.autonomyRequiredH, 0)} h required`, result: `${fmt(adeq.energy.autonomyFromBessH, 1)} h` },
                      { label: "Engines in island", expr: `${fmt(adeq.energy.engineFirmKW / 1000, 2)} MW firm against ${fmt(adeq.energy.islandLoadKW / 1000, 2)} MW island load`, result: adeq.energy.enginesCarryIsland ? "can carry it" : "cannot carry it alone" },
                      { label: `Worst ${adeq.energy.worstWindowH} h renewable spell`, expr: `from ${adeq.energy.worstWindowLabel} — renewables cover ${fmt(adeq.energy.worstRenewableShare * 100, 1)} % of load`, result: `${fmt(adeq.energy.worstDeficitMWh, 0)} MWh from storage and fuel` },
                    ]} />}
                  </div>
                </div>

                {/* Power */}
                <div className={`rounded border ${T.tile}`}>
                  <div className={`flex items-center justify-between border-b px-2 py-1.5 ${T.rule}`}>
                    <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Power adequacy</span>
                    <Badge v={adeq.power.verdict} />
                  </div>
                  <div className="p-2">
                    <div className={`mb-2 font-mono text-xs ${T.tone.cyan}`}>{adeq.power.governing}</div>
                    {fixes && fixes.power.length > 0 && (
                      <div className={`mb-2 rounded border p-2 ${T.notice.warn}`}>
                        <div className="mb-1 text-xs font-semibold uppercase tracking-wide">To make this pass</div>
                        <ul className="space-y-1">
                          {fixes.power.map((f, k) => <li key={k} className="text-xs">· {f}</li>)}
                        </ul>
                      </div>
                    )}
                    {detail.reliability === "detail" && <Trace lines={[
                      { label: "Coincident peak", expr: `site peak ${fmt(stats.peakKW / 1000, 2)} MW + parasitics ${fmt(adeq.power.parasiticKW / 1000, 2)} MW`, result: `${fmt(adeq.power.coincidentPeakKW / 1000, 2)} MW` },
                      { label: "Firm capacity, all", expr: "grid + engines + turbine + BESS power; renewables count zero", result: `${fmt(adeq.power.firmKW / 1000, 2)} MW` },
                      { label: "Largest single unit", expr: adeq.power.largestUnit ? `${adeq.power.largestUnit.name}${adeq.power.losesGridForming ? " — also the grid-forming source" : ""}` : "none", result: `${fmt((adeq.power.largestUnit?.kW || 0) / 1000, 2)} MW` },
                      { label: "Firm after N-1", expr: adeq.power.applyN1 ? "largest unit removed" : "not applied — no islanding requirement", result: `${fmt(adeq.power.firmAfterN1KW / 1000, 2)} MW` },
                      { label: "Margin", expr: "firm after N-1 − coincident peak", result: `${fmt(adeq.power.marginKW / 1000, 2)} MW` },
                    ]} />}
                    {detail.reliability === "detail" && <div className={`mt-2 max-h-32 overflow-auto rounded border ${T.panel}`}>
                      <table className="w-full text-right font-mono text-xs">
                        <tbody>
                          {adeq.power.units.map((u, i) => (
                            <tr key={i} className={`border-b ${T.divide}`}>
                              <td className={`px-2 py-0.5 text-left ${u === adeq.power.largestUnit ? T.tone.amber : T.muted}`}>
                                {u.name}{u.gridForming ? " ⚡" : ""}
                              </td>
                              <td className="px-2 py-0.5">{fmt(u.kW / 1000, 2)} MW</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>}
                  </div>
                </div>

                {/* Dynamic */}
                <div className={`rounded border ${T.tile}`}>
                  <div className={`flex items-center justify-between border-b px-2 py-1.5 ${T.rule}`}>
                    <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Dynamic adequacy</span>
                    <Badge v={adeq.dynamic.verdict} />
                  </div>
                  <div className="p-2">
                    <div className={`mb-2 font-mono text-xs ${T.tone.cyan}`}>{adeq.dynamic.governing}</div>
                    {fixes && fixes.dynamic.length > 0 && (
                      <div className={`mb-2 rounded border p-2 ${T.notice.warn}`}>
                        <div className="mb-1 text-xs font-semibold uppercase tracking-wide">To make this pass</div>
                        <ul className="space-y-1">
                          {fixes.dynamic.map((f, k) => <li key={k} className="text-xs">· {f}</li>)}
                        </ul>
                      </div>
                    )}
                    {detail.reliability === "detail" && <Trace lines={[
                      { label: "Largest load step", expr: mode === "aidc" ? "collective compute swing" : "specified separately from the profile", result: `${fmt(adeq.dynamic.loadStepKW / 1000, 2)} MW` },
                      { label: "Motor start", expr: `${fmt(char.motorKW, 0)} kW × ${fmt(adeq.dynamic.inrush, 1)} inrush (${adeq.dynamic.motorMethod})`, result: `${fmt(adeq.dynamic.motorStepKW / 1000, 2)} MW` },
                      { label: "Governing step", expr: "the larger of the two", result: `${fmt(adeq.dynamic.worstStepKW / 1000, 2)} MW` },
                      { label: "BESS fast response", expr: res.bess.gridForming ? `${fmt(res.bess.powerKW / 1000, 2)} MW × ${fmt(res.bess.gridFormingStepPct, 0)} % step capability` : "grid-following — no step capability credited", result: `${fmt(adeq.dynamic.bessStepKW / 1000, 2)} MW` },
                      { label: "Engine step acceptance", expr: `${adeq.dynamic.enginesOnline} unit(s) online (dispatch maximum, or what the island needs) × ${fmt(res.engine.stepAcceptancePct, 0)} % of rating`, result: `${fmt(adeq.dynamic.engineStepKW / 1000, 2)} MW` },
                      { label: "System inertia", expr: `rotating plant only, H ${fmt(CONSTANTS.INERTIA_H_ENGINE_S, 1)} s engines / ${fmt(CONSTANTS.INERTIA_H_TURBINE_S, 1)} s turbine`, result: `${fmt(adeq.dynamic.inertiaMWs, 1)} MW·s` },
                      { label: "RoCoF", expr: `ΔP ${fmt(adeq.dynamic.deficitMW, 2)} MW × 50 Hz ÷ (2 × ΣH·S)`, result: adeq.dynamic.rocof === Infinity ? "no inertia" : `${fmt(adeq.dynamic.rocof, 2)} Hz/s` },
                      { label: "Frequency nadir", expr: `RoCoF × ${fmt(CONSTANTS.GOVERNOR_RESPONSE_TIME_S, 1)} s governor response`, result: adeq.dynamic.nadirHz === Infinity ? "collapse" : `−${fmt(adeq.dynamic.nadirHz, 2)} Hz` },
                    ]} />}
                    {detail.reliability === "detail" && <p className={`mt-2 text-xs ${T.faint}`}>
                      First-order estimate. Thresholds: RoCoF {fmt(CONSTANTS.ROCOF_PASS_HZ_PER_S, 1)} / {fmt(CONSTANTS.ROCOF_MARGINAL_HZ_PER_S, 1)} Hz/s,
                      nadir {fmt(CONSTANTS.FREQ_NADIR_PASS_HZ, 1)} / {fmt(CONSTANTS.FREQ_NADIR_MARGINAL_HZ, 1)} Hz. Not a substitute for an EMT study.
                    </p>}
                  </div>
                </div>
              </div>
            </Panel>

            <Panel title="Checks" step="9b" sub="warnings and notes, never blockers"
              right={
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 font-mono text-xs ${notices.some((n) => n.level === "warn") ? T.chipWarn : T.chipOk}`}>
                    {notices.filter((n) => n.level === "warn").length} checks
                  </span>
                  <span className={`rounded border px-2 py-0.5 font-mono text-xs ${T.chipIdle}`}>
                    {notices.filter((n) => n.level === "info").length} notes
                  </span>
                  <Seg value={noticesOpen ? "open" : "closed"} onChange={(v) => setNoticesOpen(v === "open")}
                    options={[{ value: "closed", label: "Reduce" }, { value: "open", label: "Expand" }]} />
                </div>
              }>
              {notices.length === 0 ? (
                <div className={`rounded border px-2 py-2 text-xs ${T.notice.info}`}>Nothing flagged for the current inputs.</div>
              ) : noticesOpen ? (
                <Notices items={notices} />
              ) : (
                <ul className="space-y-0.5">
                  {notices.map((n, i) => (
                    <li key={i} className={`truncate font-mono text-xs ${n.level === "warn" ? T.tone.amber : T.muted}`}>
                      <span className="uppercase mr-2">{n.level === "warn" ? "check" : "note"}</span>{n.text}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>)}

          {/* ================= PHASE 3 — BOM ================= */}
          {/* ================= PHASE 4 — COSTS AND LCOE ================= */}
          {tab === 9 && !runOut && <NeedsRun />}
          {tab === 9 && runOut && cost && (
            <Panel title="LCOE" step="10" sub="every assumption that produced the number is on this screen"
              right={<span className={`rounded border px-2 py-0.5 font-mono text-xs ${T.chipWarn}`}>estimate class: AACE Class 5 (−30 % / +50 %)</span>}>

              {/* The formula, written out */}
              <div className={`rounded border p-3 ${T.tile}`}>
                <div className={`mb-2 text-xs uppercase tracking-wide ${T.faint}`}>Levelised cost of energy</div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="text-center">
                    <div className={`border-b px-3 pb-1 font-mono text-xs ${T.rule} ${T.title}`}>
                      CAPEX₀ + Σₜ (O&amp;M + fuel + grid + augmentation − export) ÷ (1+r)ᵗ
                    </div>
                    <div className={`px-3 pt-1 font-mono text-xs ${T.title}`}>Σₜ E_t ÷ (1+r)ᵗ</div>
                  </div>
                  <span className={`font-mono text-lg ${T.tone.cyan}`}>= {fmt(lcoeBoundary === "it" ? cost.lcoeIT : cost.lcoeFacility, 1)} €/MWh</span>
                  <Seg value={lcoeBoundary} onChange={setLcoeBoundary}
                    options={[{ value: "facility", label: "at facility busbar" }, ...(mode === "aidc" ? [{ value: "it", label: "delivered to IT" }] : [])]} />
                </div>
                <div className={`mt-2 font-mono text-xs ${T.tone.amber}`}>
                  Boundary: {lcoeBoundary === "it"
                    ? `per MWh delivered to IT — ${fmt(cost.itEnergyMWh, 0)} MWh/yr at the rack, excluding cooling and losses`
                    : `per MWh at the facility busbar — ${fmt(cost.servedMWh, 0)} MWh/yr served`}.
                  These are different numbers; comparing one against the other makes a scenario comparison meaningless.
                </div>
              </div>

              {/* The same number, opened up */}
              {lcoeStack && (
                <div className={`mt-3 rounded border p-3 ${T.tile}`}>
                  <div className={`mb-1 text-xs uppercase tracking-wide ${T.faint}`}>LCOE breakdown</div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={lcoeStack.pie} dataKey="value" nameKey="label" cx="50%" cy="50%"
                            innerRadius="42%" outerRadius="78%" paddingAngle={1} isAnimationActive={false}
                            stroke={T.chart.tipBg} strokeWidth={1}>
                            {lcoeStack.pie.map((sg) => <Cell key={sg.key} fill={sg.colour} />)}
                          </Pie>
                          <Tooltip contentStyle={tip}
                            formatter={(v, n) => [`${fmt(v, 2)} €/MWh · ${fmt(100 * v / (lcoeStack.gross || 1), 0)} % of gross cost`, n]} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    {/* The same slices as a list, in the order the pie reads, with
                        the €/MWh each one carries and its share of the gross cost. */}
                    <div className="grid grid-cols-1 gap-x-4 gap-y-1 self-center sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
                      {lcoeStack.segs.map((sg) => (
                        <div key={sg.key} className="flex items-center gap-2">
                          <span className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: sg.colour }} />
                          <span className={`truncate text-xs ${T.muted}`}>{sg.label}</span>
                          <span className={`ml-auto shrink-0 font-mono text-xs ${sg.value < 0 ? T.tone.emerald : T.title}`}>
                            {fmt(sg.value, 1)}
                          </span>
                          <span className={`w-10 shrink-0 text-right font-mono text-xs ${T.ghost}`}>
                            {fmt(100 * sg.value / (lcoeStack.gross || 1), 0)}%
                          </span>
                        </div>
                      ))}
                      {lcoeStack.credits.length > 0 && (
                        <div className={`col-span-full mt-1 text-xs ${T.faint}`}>
                          A pie cannot show a negative slice, so the credit
                          {lcoeStack.credits.length > 1 ? "s are" : " is"} listed above but not drawn. Slices are shares of
                          the gross cost of {fmt(lcoeStack.gross, 1)} €/MWh; the credits bring it to {fmt(lcoeStack.total, 1)} €/MWh.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className={`mt-2 flex flex-wrap items-center gap-4 border-t pt-2 ${T.rule}`}>
                    <span className={`text-xs ${T.faint}`}>
                      CAPEX: <span className={`font-mono ${T.title}`}>
                        {fmt(lcoeStack.segs.filter((x) => x.kind === "CAPEX").reduce((a, x) => a + x.value, 0), 1)} €/MWh
                      </span>
                    </span>
                    <span className={`text-xs ${T.faint}`}>
                      OPEX: <span className={`font-mono ${T.title}`}>
                        {fmt(lcoeStack.segs.filter((x) => x.kind === "OPEX").reduce((a, x) => a + x.value, 0), 1)} €/MWh
                      </span>
                    </span>
                    <span className={`ml-auto font-mono text-xs ${T.tone.cyan}`}>
                      total {fmt(lcoeStack.total, 1)} €/MWh
                    </span>
                  </div>
                  <div className={`mt-1 text-xs ${T.faint}`}>
                    Segments are shares of the same €/MWh and sum to the figure above. Cool colours are capital cost, warm
                    colours are operating cost, green is a credit against cost.
                  </div>

                  {runOut && runOut.variants && runOut.variants.length > 0 && (
                    <div className={`mt-3 border-t pt-2 ${T.rule}`}>
                      <div className={`mb-1 text-xs uppercase tracking-wide ${T.faint}`}>Comparison with alternative designs</div>
                      <div className="h-64 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart layout="vertical" margin={{ top: 4, right: 44, left: 8, bottom: 0 }}
                            data={[{ name: "This design", lcoe: Math.round((lcoeBoundary === "it" ? cost.lcoeIT : cost.lcoeFacility) * 10) / 10, self: 1 },
                              ...runOut.variants.map((v) => ({ name: v.label, lcoe: v.lcoe, self: 0 }))]}>
                            <CartesianGrid stroke={T.chart.grid} horizontal={false} />
                            <XAxis type="number" tick={axis} unit=" €" tickFormatter={(v) => fmt(v, 0)} />
                            <YAxis type="category" dataKey="name" tick={axis} width={230} />
                            <Tooltip contentStyle={tip} formatter={(v) => [`${fmt(v, 1)} €/MWh`, "LCOE"]} />
                            <Bar dataKey="lcoe" name="€/MWh" fill={T.chart.bar1}
                              label={{ position: "right", fontSize: 10, fill: T.chart.axis, formatter: (v) => fmt(v, 1) }} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      {/* The same scenarios as numbers, because the bar only carries one of them */}
                      <div className={`mt-2 w-full overflow-auto rounded border ${T.tile}`}>
                        <table className="w-full text-right font-mono text-sm">
                          <thead className={T.panel}>
                            <tr className={`border-b ${T.rule}`}>
                              {["Scenario", "LCOE €/MWh", "Δ vs this design", "Capex M€", "Import MWh/yr",
                                "Generator MWh/yr", "Renewable %", "Unserved MWh/yr"].map((h, i) => (
                                <th key={h} className={`px-1.5 py-1 text-xs font-normal ${T.faint} ${i === 0 ? "text-left" : ""}`}>{h}</th>))}
                            </tr>
                          </thead>
                          <tbody>
                            <tr className={`border-b ${T.divide} ${T.soft.cyan}`}>
                              <td className={`px-1.5 py-0.5 text-left ${T.title}`}>This design</td>
                              <td className={`px-1.5 py-0.5 ${T.tone.cyan}`}>{fmt(cost.lcoeFacility, 1)}</td>
                              <td className={`px-1.5 py-0.5 ${T.ghost}`}>—</td>
                              <td className="px-1.5 py-0.5">{fmt(cost.capex.total / 1e6, 1)}</td>
                              <td className="px-1.5 py-0.5">{fmt(disp.summary.importMWh, 0)}</td>
                              <td className="px-1.5 py-0.5">{fmt(disp.summary.engineMWh, 0)}</td>
                              <td className={`px-1.5 py-0.5 ${T.tone.emerald}`}>{fmt(disp.summary.renewableFraction * 100, 1)}</td>
                              <td className="px-1.5 py-0.5">{fmt(disp.summary.unservedMWh, 1)}</td>
                            </tr>
                            {runOut.variants.map((v, i) => (
                              <tr key={i} title={v.note} className={`border-b ${T.divide}`}>
                                <td className={`px-1.5 py-0.5 text-left ${T.title}`}>
                                  {v.label}
                                  {v.note ? <span className={`ml-1 font-sans text-xs ${T.faint}`}>— {v.note}</span> : null}
                                </td>
                                <td className="px-1.5 py-0.5">{fmt(v.lcoe, 1)}</td>
                                <td className={`px-1.5 py-0.5 ${v.lcoe > cost.lcoeFacility ? T.tone.emerald : T.tone.rose}`}>
                                  {(v.lcoe - cost.lcoeFacility >= 0 ? "+" : "") + fmt(v.lcoe - cost.lcoeFacility, 1)}
                                </td>
                                <td className="px-1.5 py-0.5">{fmt(v.capexM, 1)}</td>
                                <td className="px-1.5 py-0.5">{fmt(v.importMWh, 0)}</td>
                                <td className="px-1.5 py-0.5">{fmt(v.engineMWh, 0)}</td>
                                <td className={`px-1.5 py-0.5 ${T.tone.emerald}`}>{fmt(v.renewablePct, 1)}</td>
                                <td className={`px-1.5 py-0.5 ${v.unserved > 0.01 ? T.tone.rose : T.ghost}`}>{fmt(v.unserved, 1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className={`mt-1 text-xs ${T.faint}`}>
                        Every scenario is the same site and the same load, priced on the same assumptions, and dispatched with
                        the merit order so the comparison is like-for-like. A positive delta means this design is the cheaper
                        of the two.
                        {runOut.variants.some((v) => v.unserved > 0.01)
                          && " A scenario that leaves energy unserved is not a viable design and its cost per MWh is not comparable — read the unserved column before quoting any of it."}
                        {!res.engine.economicRun && runOut.variants.some((v) => /gas generators/.test(v.label))
                          && " The gas row carries the capital cost of the fleet and no output, because economic running is switched off on the Equipment tab."}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* The money assumptions live here, with the number they produce */}
              <div className={`mt-3 mb-1 text-xs uppercase tracking-wide ${T.faint}`}>Financing assumptions</div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field tier="critical" source="site" label="Project life" unit="years"
                  explain="Years of costs and energy in the levelised cost.">
                  <Num value={ctx.lifeYears} onChange={(v) => setCtx((s2) => ({ ...s2, lifeYears: v }))} />
                </Field>
                <Field tier="critical" source="site" label="Discount rate, real" unit="%/yr"
                  explain="Return the capital must earn, inflation stripped out.">
                  <Num value={ctx.discountPct} step={0.1} onChange={(v) => setCtx((s2) => ({ ...s2, discountPct: v }))} />
                </Field>
                <Field computed label="Currency" unit="—"><Txt value="EUR" readOnly /></Field>
                <Field computed label="Cost boundary" unit="—" explain="Measured at the busbar, or after cooling losses at the IT.">
                  <Txt value={lcoeBoundary === "it" ? "delivered to IT" : "at the facility busbar"} readOnly />
                </Field>
                <Field computed label="Capex share of the LCOE" unit="%">
                  <Txt value={cost && cost.npvCost > 0 ? `${fmt(100 * cost.capex.total / cost.npvCost, 0)} %` : "—"} readOnly />
                </Field>
                <Field computed label="Opex share of the LCOE" unit="%">
                  <Txt value={cost && cost.npvCost > 0 ? `${fmt(100 * (cost.npvCost - cost.capex.total) / cost.npvCost, 0)} %` : "—"} readOnly />
                </Field>
              </div>

              {/* Assumptions on the same screen as the number */}
              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
                <Stat label="Specific yield in use" value={fmt(loc.specificYield_kWh_per_kWp, 0)} unit="kWh/kWp"
                  tone={resourceSource.pv === "site" ? "emerald" : "amber"} />
                <Stat label="Yield source" value={resourceSource.pv === "site" ? "site data" : "library"} unit={`±${resourceSource.pv === "site" ? CONSTANTS.SITE_YIELD_UNCERTAINTY_PCT : CONSTANTS.LIBRARY_YIELD_UNCERTAINTY_PCT} %`}
                  tone={resourceSource.pv === "site" ? "emerald" : "amber"} />
                <Stat label="Discount rate, real" value={fmt(ctx.discountPct, 1)} unit="%/yr" tone="cyan" />
                <Stat label="Project life" value={fmt(ctx.lifeYears, 0)} unit="years" />
                <Stat label="PV degradation" value={fmt(res.pv.degradationPctPerYr, 2)} unit="%/yr" />
                <Stat label="BESS augmentation" value={costs.AUGMENTATION_YEARS || "none"} unit="year(s)" tone="violet" />
                <Stat label="Total capex" value={fmt(cost.capex.total / 1e6, 2)} unit="M€" tone="amber" />
                <Stat label="NPV of lifetime cost" value={fmt(cost.npvCost / 1e6, 2)} unit="M€" />
                <Stat label="Discounted energy" value={fmt(cost.npvEnergyFacility / 1000, 1)} unit="GWh" />
                <Stat label="Renewable fraction" value={fmt(disp.summary.renewableFraction * 100, 1)} unit="%" tone="emerald" />
                {mode === "aidc" && <Stat label="Capex per MW IT" value={fmt(cost.capex.total / 1e6 / Math.max(0.001, aidcYearMW), 2)} unit="M€/MW IT" tone="amber" />}
                <Stat label="Marginal energy cost" value={fmt(cost.marginalEUR_per_MWh, 1)} unit="€/MWh" />
              </div>

              {/* Cost breakdown */}
              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div>
                  <div className={`mb-1 text-xs ${T.title}`}>CAPEX — capital expenditure</div>
                  <div className={`mb-1 text-xs ${T.faint}`}>By component (M€) and contribution to LCOE (€/MWh)</div>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={cost.breakdown.map((b) => ({ name: b.name, capex: +(b.capex / 1e6).toFixed(2), lcoe: +b.lcoe.toFixed(1) }))}
                        margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                        <CartesianGrid stroke={T.chart.grid} vertical={false} />
                        <XAxis dataKey="name" tick={axis} interval={0} angle={-20} textAnchor="end" height={50} />
                        <YAxis yAxisId="l" tick={axis} />
                        <YAxis yAxisId="r" orientation="right" tick={axis} />
                        <Tooltip contentStyle={tip} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar yAxisId="l" dataKey="capex" name="Capex (M€)" fill={T.chart.bar1} />
                        <Bar yAxisId="r" dataKey="lcoe" name="LCOE share (€/MWh)" fill={T.chart.bar2} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div>
                  <div className={`mb-1 text-xs ${T.title}`}>OPEX — operating expenditure, discounted over the project life</div>
                  <div className={`mb-1 text-xs ${T.faint}`}>By category (M€) and contribution to LCOE (€/MWh)</div>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={cost.opexBreakdown.map((b) => ({ name: b.name, value: +(b.value / 1e6).toFixed(2), lcoe: +b.lcoe.toFixed(1) }))}
                        margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                        <CartesianGrid stroke={T.chart.grid} vertical={false} />
                        <XAxis dataKey="name" tick={axis} interval={0} angle={-20} textAnchor="end" height={50} />
                        <YAxis yAxisId="l" tick={axis} />
                        <YAxis yAxisId="r" orientation="right" tick={axis} />
                        <Tooltip contentStyle={tip} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar yAxisId="l" dataKey="value" name="Discounted cost (M€)" fill={T.chart.engineC} />
                        <Bar yAxisId="r" dataKey="lcoe" name="LCOE share (€/MWh)" fill={T.chart.bessC} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* Sensitivity */}
              <div className="mt-3">
                <div className={`mb-1 text-xs ${T.faint}`}>
                  LCOE sensitivity (€/MWh) — specific yield against capex, fuel price and discount rate.
                  The horizontal axis is % change, except discount rate which is ±2 percentage points at the extremes.
                </div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sens} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                      <CartesianGrid stroke={T.chart.grid} />
                      <XAxis dataKey="delta" tick={axis} unit="%" />
                      <YAxis tick={axis} />
                      <Tooltip contentStyle={tip} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="yield" name="Specific yield" stroke={T.chart.temp} strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="capex" name="Capex" stroke={T.chart.imp} strokeWidth={1.5} dot={false} />
                      <Line type="monotone" dataKey="fuel" name="Fuel price" stroke={T.chart.engineC} strokeWidth={1.5} dot={false} />
                      <Line type="monotone" dataKey="discount" name="Discount rate" stroke={T.chart.bessC} strokeWidth={1.5} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Editable cost library */}

              <p className={`mt-2 text-xs ${T.faint}`}>
                The hourly dispatch is run once and projected across the {fmt(ctx.lifeYears, 0)}-year life with PV degradation applied;
                energy lost to degradation is re-priced at the marginal source ({fmt(cost.marginalEUR_per_MWh, 1)} €/MWh) rather than
                re-running 8760 hours per year. Pre-feasibility only — not a contractor's price, and not a substitute for a protection
                or EMT study.
              </p>
            </Panel>
          )}

          {/* ================= AUTO-SIZE ================= */}
          {tab === 10 && (
            <Panel title="Auto-size" step="11" sub="ranked search for a lower-cost compliant design">
              {sweeping && (
                <div className={`mb-3 flex flex-wrap items-center gap-3 rounded border px-3 py-2 ${T.notice.warn}`}>
                  <Spinner className="h-5 w-5" />
                  <span className="text-sm font-medium">Sweep in progress</span>
                  <span className="font-mono text-sm">{fmt(sweepElapsedS, 0)} s elapsed</span>
                  <div className={`h-2 w-56 overflow-hidden rounded ${T.tile}`}>
                    <div className="h-full rounded bg-amber-500 transition-all" style={{ width: `${Math.round(sweepPct * 100)}%` }} />
                  </div>
                  <span className="font-mono text-sm">{fmt(sweepPct * 100, 0)} %</span>
                  <span className="text-xs">
                    Every candidate is a full 8760-hour dispatch. The page stays usable; the results appear below when it finishes.
                  </span>
                </div>
              )}
              <div className={`mb-3 rounded border px-2 py-1 text-xs ${T.tile} ${T.muted}`}>
                Every candidate is run through the same hourly dispatch and the same three adequacy checks as the headline
                design. Anything that fails a check is discarded; what survives is ranked by LCOE, with the trade-off against
                renewable fraction and capital cost shown alongside — the scatter matters as much as the winner.
                {mode === "aidc" && " In AIDC mode the land, import and permit limits are applied as hard bounds."}
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-3">
                <span className={`text-xs font-semibold ${T.title}`}>Search method</span>
                <Seg value={sweep.mode === "manual" ? "manual" : "guided"}
                  onChange={(v) => setSweep((s2) => ({ ...s2, mode: v }))}
                  options={[{ value: "guided", label: "Guided — ranges proposed from the project" },
                    { value: "manual", label: "Manual ranges" }]} />
              </div>

              {sweep.mode !== "manual" && (<>
                <div className={`mb-2 flex items-center gap-2 rounded px-2 py-1 ${T.soft.cyan}`}>
                  <span className={`rounded-full px-2 font-mono text-xs ${T.chip}`}>1</span>
                  <span className={`text-sm font-semibold ${T.head}`}>Search space — derived from the project</span>
                </div>
                <div className={`mb-2 rounded border px-2 py-2 text-xs ${T.soft.cyan} ${T.muted}`}>
                  The ranges below are proposed from the load, the connection, the resource and the land — each bound is a
                  named anchor, so every tested size has a reason. Override a bound or an inclusion where the project
                  knows better; zero stays in every range, so "none of this asset" is always among the candidates.
                </div>
                {/* One block per asset class. Each one states what bounds the axis,
                    what sizes will be tested, and the override that moves it. */}
                <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">

                  {/* --- Solar PV --- */}
                  <div className={`rounded border p-2 ${T.tile}`}>
                    <div className={`mb-2 flex items-center gap-2 border-b pb-1 ${T.rule}`}>
                      <Icon name="solar" className="h-4 w-4" />
                      <span className={`text-sm font-semibold ${T.title}`}>Solar PV</span>
                      <span className={`ml-auto rounded px-2 py-0.5 font-mono text-xs ${guidedSpace.pv.include ? T.chipOk : T.chipIdle}`}>
                        {guidedSpace.pv.include ? `${guidedSpace.pv.levelsKWp.length} sizes` : "excluded"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field tier="critical" label="Include in the search" source="site" unit="—"
                        explain="Whether PV sizes are searched. The bound comes from the land available or the over-build limit.">
                        <Sel value={guidedSpace.pv.include ? "yes" : "no"} prompt={null}
                          onChange={(v) => setSweep((s2) => ({ ...s2, gPvOn: v === "yes" }))}
                          options={[{ value: "yes", label: "Searched" }, { value: "no", label: "Excluded" }]} />
                      </Field>
                      <Field tier="advanced" label="Upper bound override" source="site" unit="MWp — blank uses the proposal">
                        <Num value={sweep.gPvMaxMWp} step={0.5} onChange={(v) => setSweep((s2) => ({ ...s2, gPvMaxMWp: v }))} />
                      </Field>
                    </div>
                    <div className={`mt-1 text-xs ${T.faint}`}>
                      Bound by {proposedSpace.pv.boundBy} at {fmt(guidedSpace.pv.maxKWp / 1000, 1)} MWp ·
                      load-match {fmt(proposedSpace.pv.loadMatchKWp / 1000, 1)} MWp ·
                      sizes tested {guidedSpace.pv.levelsKWp.map((v) => fmt(v / 1000, 1)).join(", ")} MWp
                    </div>
                  </div>

                  {/* --- Battery storage --- */}
                  <div className={`rounded border p-2 ${T.tile}`}>
                    <div className={`mb-2 flex items-center gap-2 border-b pb-1 ${T.rule}`}>
                      <Icon name="battery" className="h-4 w-4" />
                      <span className={`text-sm font-semibold ${T.title}`}>Battery storage</span>
                      <span className={`ml-auto rounded px-2 py-0.5 font-mono text-xs ${guidedSpace.bess.include ? T.chipOk : T.chipIdle}`}>
                        {guidedSpace.bess.include ? `${guidedSpace.bess.levelsKW.length} powers × ${guidedSpace.bess.durationsH.length} durations` : "excluded"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field tier="critical" label="Include in the search" source="site" unit="—"
                        explain="Power levels come from the three anchors: connection shortfall, peak shaving depth and PV surplus absorption.">
                        <Sel value={guidedSpace.bess.include ? "yes" : "no"} prompt={null}
                          onChange={(v) => setSweep((s2) => ({ ...s2, gBessOn: v === "yes" }))}
                          options={[{ value: "yes", label: "Searched" }, { value: "no", label: "Excluded" }]} />
                      </Field>
                      <Field tier="advanced" label="Power bound override" source="site" unit="MW — blank uses the proposal">
                        <Num value={sweep.gBessMaxMW} step={0.5} onChange={(v) => setSweep((s2) => ({ ...s2, gBessMaxMW: v }))} />
                      </Field>
                    </div>
                    <div className={`mt-1 text-xs ${T.faint}`}>
                      Anchors — connection shortfall {fmt(proposedSpace.bess.anchors.deficitKW / 1000, 1)} MW ·
                      shaving depth {fmt(proposedSpace.bess.anchors.shaveKW / 1000, 1)} MW ·
                      surplus absorption {fmt(proposedSpace.bess.anchors.surplusKW / 1000, 1)} MW ·
                      durations {guidedSpace.bess.durationsH.join(", ")} h
                    </div>
                  </div>

                  {/* --- Wind --- */}
                  <div className={`rounded border p-2 ${T.tile}`}>
                    <div className={`mb-2 flex items-center gap-2 border-b pb-1 ${T.rule}`}>
                      <Icon name="wind" className="h-4 w-4" />
                      <span className={`text-sm font-semibold ${T.title}`}>Wind</span>
                      <span className={`ml-auto rounded px-2 py-0.5 font-mono text-xs ${guidedSpace.wind.include ? T.chipOk : T.chipIdle}`}>
                        {guidedSpace.wind.include ? `${guidedSpace.wind.levelsKW.length} sizes` : "excluded"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field tier="critical" label="Include in the search" source="site" unit="—"
                        explain="Wind is proposed only where the resource clears the screening threshold; override to force it in or out.">
                        <Sel value={guidedSpace.wind.include ? "yes" : "no"} prompt={null}
                          onChange={(v) => setSweep((s2) => ({ ...s2, gWindOn: v === "yes" }))}
                          options={[{ value: "no", label: "Excluded" }, { value: "yes", label: "Searched" }]} />
                      </Field>
                      <Field tier="advanced" label="Upper bound override" source="site" unit="MW — blank uses the proposal">
                        <Num value={sweep.gWindMaxMW} step={0.5} onChange={(v) => setSweep((s2) => ({ ...s2, gWindMaxMW: v }))} />
                      </Field>
                    </div>
                    <div className={`mt-1 text-xs ${T.faint}`}>{proposedSpace.wind.reason}</div>
                  </div>

                  {/* --- Generators --- */}
                  <div className={`rounded border p-2 ${T.tile}`}>
                    <div className={`mb-2 flex items-center gap-2 border-b pb-1 ${T.rule}`}>
                      <Icon name="engine" className="h-4 w-4" />
                      <span className={`text-sm font-semibold ${T.title}`}>Generators — gas or diesel</span>
                      <span className={`ml-auto rounded px-2 py-0.5 font-mono text-xs ${guidedSpace.engine.include ? T.chipOk : T.chipIdle}`}>
                        {guidedSpace.engine.include ? `${guidedSpace.engine.levels.length} fleet sizes` : "excluded"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field tier="critical" label="Include in the search" source="site" unit="—"
                        explain="Included by default where a firm shortfall exists, or where economic running is switched on. Forcing it in tests fleet sizes from a quarter of the peak up to the whole peak.">
                        <Sel value={guidedSpace.engine.include ? "yes" : "no"} prompt={null}
                          onChange={(v) => setSweep((s2) => ({ ...s2, gEngineOn: v === "yes" }))}
                          options={[{ value: "no", label: "Excluded" }, { value: "yes", label: "Searched" }]} />
                      </Field>
                      <Field tier="critical" label="Fuel searched" source="site" unit="—"
                        explain="Which fuel the candidate generators burn. This is priced from the Location tab: gas in €/MWh thermal, diesel in €/litre.">
                        <Sel value={sweep.gEngineFuel} prompt={null}
                          onChange={(v) => setSweep((s2) => ({ ...s2, gEngineFuel: v }))}
                          options={[{ value: "project", label: `As the Equipment tab (${res.engine.fuelType || "gas"})` },
                            { value: "gas", label: "Gas engines" }, { value: "diesel", label: "Diesel engines" }]} />
                      </Field>
                      <Field tier="advanced" label="Unit rating" source="site" unit="kW each — blank uses the Equipment tab value">
                        <Num value={sweep.gEngineUnitKW} step={100} onChange={(v) => setSweep((s2) => ({ ...s2, gEngineUnitKW: v }))} />
                      </Field>
                      <Field computed label="Marginal cost of the searched fuel" unit="€/MWh">
                        <Txt value={`${fmt(sweepEngineMarginal, 1)} €/MWh`} readOnly />
                      </Field>
                    </div>
                    <div className={`mt-1 text-xs ${T.faint}`}>
                      {guidedSpace.engine.reason}
                      {guidedSpace.engine.include && guidedSpace.engine.levels.length > 1 &&
                        ` · fleet sizes tested ${guidedSpace.engine.levels.join(", ")} × ${fmt(guidedSpace.engine.unitKW, 0)} kW`}
                    </div>
                    {!res.engine.economicRun && (
                      <div className={`mt-1 rounded border px-2 py-1 text-xs ${T.notice.warn}`}>
                        Economic running is switched off on the Equipment tab, so a generator only starts when nothing else
                        can serve the load. On a connection that covers the peak it will never start, and the search will
                        return no generators whatever the fuel price — the units would be capital cost and nothing else.
                        Switch economic running on to ask whether generation pays against the import price.
                      </div>
                    )}
                  </div>
                </div>

                <Advanced key={`space-${density}`} title="How each range was derived — anchors and bounds" count={8} defaultOpen={showAll}>
                <Trace lines={[
                  { label: "PV load-match capacity", expr: `${fmt(stats.annualMWh, 0)} MWh/yr ÷ ${fmt(proposedSpace.pv.loadMatchKWp > 0 ? stats.annualMWh * 1000 / proposedSpace.pv.loadMatchKWp : 0, 0)} kWh/kWp`, result: `${fmt(proposedSpace.pv.loadMatchKWp / 1000, 1)} MWp` },
                  { label: "PV search scale", expr: `min(load-match, busbar absorption: peak + auxiliaries + export capacity + storage power, × DC/AC ratio)`, result: `${fmt(proposedSpace.pv.scaleKWp / 1000, 1)} MWp` },
                  { label: "PV hard bound", expr: proposedSpace.pv.boundBy, result: `${fmt(guidedSpace.pv.maxKWp / 1000, 1)} MWp` },
                  { label: "Storage anchor — connection shortfall", expr: `peak + auxiliaries − import capacity`, result: proposedSpace.bess.anchors.deficitKW > 0 ? `${fmt(proposedSpace.bess.anchors.deficitKW / 1000, 1)} MW` : "none — the connection covers the peak" },
                  { label: "Storage anchor — peak shaving depth", expr: `peak − P${fmt(CONSTANTS.AUTOSIZE.SHAVE_QUANTILE * 100, 0)} of the load duration curve`, result: `${fmt(proposedSpace.bess.anchors.shaveKW / 1000, 1)} MW` },
                  { label: "Storage anchor — PV surplus absorption", expr: `P${fmt(CONSTANTS.AUTOSIZE.SURPLUS_POWER_QUANTILE * 100, 0)} of hourly PV surplus at load-match capacity`, result: `${fmt(proposedSpace.bess.anchors.surplusKW / 1000, 1)} MW · median surplus ${fmt(proposedSpace.bess.medianDailySurplusMWh, 1)} MWh/day` },
                  { label: "Engine requirement", expr: proposedSpace.engine.reason, result: proposedSpace.engine.needUnits > 0 ? `${proposedSpace.engine.needUnits} × ${fmt(proposedSpace.engine.unitKW, 0)} kW` : "not proposed" },
                  { label: "Wind resource screening", expr: proposedSpace.wind.reason, result: proposedSpace.wind.include || sweep.gWindOn ? `load-match ${fmt(proposedSpace.wind.loadMatchKW / 1000, 1)} MW` : "excluded by default" },
                ]} />
                </Advanced>

                <div className={`mt-4 mb-2 flex flex-wrap items-center gap-3 rounded px-2 py-2 ${T.soft.cyan}`}>
                  <span className={`rounded-full px-2 font-mono text-xs ${T.chip}`}>2</span>
                  <span className={`text-sm font-semibold ${T.head}`}>Run the search</span>
                  <button onClick={runGuided} disabled={sweeping}
                    className={`flex items-center gap-2 rounded border px-4 py-1.5 text-sm font-medium ${sweeping ? T.chipIdle : T.chipAlert}`}>
                    {sweeping && <Spinner className="h-4 w-4" />}
                    {sweeping ? "Searching…" : sweepOut ? "Search again" : "Search"}
                  </button>
                  <span className={`text-xs ${T.faint}`}>
                    {sweepOut && sweepOut.kind === "guided"
                      ? `${sweepOut.coarseTried} coarse + ${sweepOut.refineTried} refinement candidates in the merit order${sweepOut.shortlisted ? `, ${sweepOut.shortlisted} re-priced under optimisation` : ""} — ${fmt(sweepOut.ms / 1000, 1)} s`
                      : `≈ ${fmt(guidedCoarseCount, 0)} coarse candidates, then refinement around the leader, in the merit order${res.dispatchMode === "optimised" ? `; the ${CONSTANTS.AUTOSIZE.OPT_SHORTLIST} best designs are then re-priced under optimisation (adds roughly ${fmt(CONSTANTS.AUTOSIZE.OPT_SHORTLIST * 2, 0)} s)` : ""}.`}
                  </span>
                  {sweeping && (
                    <div className="flex items-center gap-2">
                      <div className={`h-1.5 w-40 overflow-hidden rounded ${T.tile}`}>
                        <div className="h-full rounded bg-cyan-500 transition-all" style={{ width: `${Math.round(sweepPct * 100)}%` }} />
                      </div>
                      <span className={`font-mono text-xs ${T.tone.cyan}`}>{fmt(sweepPct * 100, 0)} %</span>
                    </div>
                  )}
                </div>
              </>)}

              {sweep.mode === "manual" && (<>
              <div className={`mb-2 flex items-center gap-2 rounded px-2 py-1 ${T.soft.cyan}`}>
                <span className={`rounded-full px-2 font-mono text-xs ${T.chip}`}>1</span>
                <span className={`text-sm font-semibold ${T.head}`}>Define the search ranges</span>
              </div>
              <div className={`mb-2 rounded border px-2 py-2 text-xs ${T.soft.cyan} ${T.muted}`}>
                The search decides whether an asset belongs in the design, so it tests sizes for anything included here —
                including assets currently switched off on the Equipment tab. Every range starts at zero, so “none of this
                asset” is always among the candidates.
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field tier="critical" label="Solar PV" source="site" unit="include in search">
                  <Sel value={sweep.includePV ? "yes" : "no"} prompt={null}
                    onChange={(v) => setSweep((s2) => ({ ...s2, includePV: v === "yes" }))}
                    options={[{ value: "yes", label: "Yes — search PV sizes" }, { value: "no", label: "No — exclude PV" }]} />
                </Field>
                {sweep.includePV && (
                  <Field tier="critical" label="PV capacity range" source="site" unit="MWp — min, max, steps"
                    explain="The search tests this many evenly spaced sizes between the smallest and the largest."
                    flag={maxPVfromLandKWp > 0 ? `capped at ${fmt(maxPVfromLandKWp / 1000, 2)} MWp by the land available` : null}>
                    <div className="flex gap-1">
                      <Num value={sweep.pvMin} step={0.5} onChange={(v) => setSweep((s2) => ({ ...s2, pvMin: v }))} />
                      <Num value={sweep.pvMax} step={0.5} onChange={(v) => setSweep((s2) => ({ ...s2, pvMax: v }))} />
                      <Num value={sweep.pvSteps} onChange={(v) => setSweep((s2) => ({ ...s2, pvSteps: v }))} />
                    </div>
                  </Field>
                )}
                <Field tier="critical" label="Battery storage" source="site" unit="include in search">
                  <Sel value={sweep.includeBess ? "yes" : "no"} prompt={null}
                    onChange={(v) => setSweep((s2) => ({ ...s2, includeBess: v === "yes" }))}
                    options={[{ value: "yes", label: "Yes — search battery sizes" }, { value: "no", label: "No — exclude storage" }]} />
                </Field>
                {sweep.includeBess && (
                  <Field tier="critical" label="Battery power range" source="site" unit="MW — min, max, steps">
                    <div className="flex gap-1">
                      <Num value={sweep.bessMin} step={0.5} onChange={(v) => setSweep((s2) => ({ ...s2, bessMin: v }))} />
                      <Num value={sweep.bessMax} step={0.5} onChange={(v) => setSweep((s2) => ({ ...s2, bessMax: v }))} />
                      <Num value={sweep.bessSteps} onChange={(v) => setSweep((s2) => ({ ...s2, bessSteps: v }))} />
                    </div>
                  </Field>
                )}
                {sweep.includeBess && (
                  <Field tier="critical" label="Battery duration options" source="site" unit="hours, comma separated">
                    <Txt value={sweep.durations} onChange={(v) => setSweep((s2) => ({ ...s2, durations: v }))} />
                  </Field>
                )}
                <Field tier="critical" label="Wind" source="site" unit="include in search">
                  <Sel value={sweep.includeWind ? "yes" : "no"} prompt={null}
                    onChange={(v) => setSweep((s2) => ({ ...s2, includeWind: v === "yes" }))}
                    options={[{ value: "no", label: "No — exclude wind" }, { value: "yes", label: "Yes — search wind sizes" }]} />
                </Field>
                {sweep.includeWind && (
                  <Field tier="critical" label="Wind capacity range" source="site" unit="MW — min, max, steps">
                    <div className="flex gap-1">
                      <Num value={sweep.windMin} step={0.5} onChange={(v) => setSweep((s2) => ({ ...s2, windMin: v }))} />
                      <Num value={sweep.windMax} step={0.5} onChange={(v) => setSweep((s2) => ({ ...s2, windMax: v }))} />
                      <Num value={sweep.windSteps} onChange={(v) => setSweep((s2) => ({ ...s2, windSteps: v }))} />
                    </div>
                  </Field>
                )}
                <Field tier="critical" label="Generators" source="site" unit="include in search">
                  <Sel value={sweep.includeEngine ? "yes" : "no"} prompt={null}
                    onChange={(v) => setSweep((s2) => ({ ...s2, includeEngine: v === "yes" }))}
                    options={[{ value: "no", label: "No — exclude generators" }, { value: "yes", label: "Yes — search unit counts" }]} />
                </Field>
                {sweep.includeEngine && (
                  <Field tier="critical" label="Generator unit size" source="site" unit="kW each">
                    <Num value={sweep.engineUnitKW} step={100} onChange={(v) => setSweep((s2) => ({ ...s2, engineUnitKW: v }))} />
                  </Field>
                )}
                {sweep.includeEngine && (
                  <Field tier="critical" label="Unit counts to test" source="site" unit="comma separated">
                    <Txt value={sweep.engineUnits} onChange={(v) => setSweep((s2) => ({ ...s2, engineUnits: v }))} />
                  </Field>
                )}
              </div>

              <div className={`mt-2 rounded border px-2 py-1 text-xs ${sweepCount > (res.dispatchMode === "optimised" ? 20 : 400) ? T.notice.warn : T.tile} ${T.muted}`}>
                <span className={`font-mono ${T.title}`}>{fmt(sweepCount, 0)}</span> combinations will be tested,
                each a full 8760-hour dispatch using {res.dispatchMode === "optimised" ? "the optimiser" : "the merit order"} —
                roughly {fmt(sweepCount * (res.dispatchMode === "optimised" ? 2.0 : 0.06), 0)} seconds.
                {res.dispatchMode === "optimised" && " Optimised runs search the import ceiling as well, so each candidate costs several dispatches. Switch to merit order to search a wide range quickly, then re-run the chosen design under optimisation."}
                {sweepCount > (res.dispatchMode === "optimised" ? 20 : 400) && " That is a long run. Reduce the number of steps, or exclude an asset, unless you intend to wait."}
                {sweepCount <= 1 && " With nothing included there is nothing to search — switch on at least one asset above."}
              </div>

              {mode === "aidc" && aidcOut && (
                <div className="mt-2">
                  <Trace lines={[
                    { label: "PV hard bound", expr: `${fmt(aidc.landPV_ha, 1)} ha ÷ ${fmt(aidc.pvAreaPerKWp, 1)} m²/kWp`, result: `${fmt(aidcOut.maxKWp / 1000, 2)} MWp max` },
                    { label: "Engine hard bound", expr: `${fmt(aidc.landEngine_m2, 0)} m² ÷ ${fmt(aidc.engineFootprint, 0)} m²/MW`, result: `${fmt(aidcOut.maxEngineMW, 1)} MW max` },
                    { label: "BESS hard bound", expr: `${fmt(aidc.landBESS_m2, 0)} m² ÷ ${fmt(aidc.bessFootprint, 0)} m²/MW`, result: `${fmt(aidcOut.maxBessMW, 1)} MW max` },
                    { label: "Ramp years tested", expr: aidc.ramp.map((r) => `y${r.year}: ${r.mwIT} MW IT`).join(", "), result: `${aidc.ramp.length} year(s)` },
                  ]} />
                </div>
              )}

              <div className={`mt-4 mb-2 flex flex-wrap items-center gap-3 rounded px-2 py-2 ${T.soft.cyan}`}>
                <span className={`rounded-full px-2 font-mono text-xs ${T.chip}`}>2</span>
                <span className={`text-sm font-semibold ${T.head}`}>Run the sweep</span>
                <button onClick={runAutoSize} disabled={sweeping}
                  className={`flex items-center gap-2 rounded border px-4 py-1.5 text-sm font-medium ${sweeping ? T.chipIdle : T.chipAlert}`}>
                  {sweeping && <Spinner className="h-4 w-4" />}
                  {sweeping ? "Sweeping…" : sweepOut ? "Run the sweep again" : "Run the sweep"}
                </button>
                <span className={`text-xs ${T.faint}`}>
                  {sweepOut ? `${sweepOut.tried} combinations tested with the ${sweepOut.method || "merit order"}, ${sweepOut.feasible.length} passed every check`
                    : "Every combination is run through the same dispatch and the same three checks."}
                </span>
              </div>
              </>)}

              {sweepOut && (<>
                <div className={`mb-2 mt-4 flex flex-wrap items-center gap-3 rounded px-2 py-2 ${T.soft.emerald}`}>
                  <span className={`rounded-full px-2 font-mono text-xs ${T.chip}`}>3</span>
                  <span className={`text-sm font-semibold ${T.head}`}>Select a design and apply it</span>
                  <span className={`text-xs ${T.faint}`}>
                    Apply writes the sizing into the Equipment tab. Nothing changes until you press it.
                  </span>
                  {sweepOut.best && (
                    <button onClick={() => applyCandidate(sweepOut.best)}
                      className={`rounded border px-4 py-1.5 text-sm font-medium ${T.chipAlert}`}>
                      Apply the best: {fmt(sweepOut.best.kWp / 1000, 1)} MWp PV · {fmt((sweepOut.best.windKW || 0) / 1000, 1)} MW wind · {fmt(sweepOut.best.bessKW / 1000, 1)} MW / {fmt(sweepOut.best.bessKWh / 1000, 1)} MWh · {sweepOut.best.units} gensets
                    </button>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Stat label="Candidates evaluated" value={fmt(sweepOut.tried, 0)} unit="" />
                  <Stat label="Passed every check" value={fmt(sweepOut.feasible.length, 0)} unit="" tone={sweepOut.feasible.length ? "emerald" : "rose"} />
                  <Stat label="Best LCOE" value={sweepOut.best ? fmt(sweepOut.best.lcoeOpt !== undefined ? sweepOut.best.lcoeOpt : sweepOut.best.lcoe, 1) : "—"} unit="€/MWh" tone="cyan" />
                  <Stat label="Search time" value={fmt(sweepOut.ms / 1000, 1)} unit="s" />
                </div>

                {sweepOut.kind === "guided" && sweepOut.best && sweepOut.contributions && sweepOut.contributions.length > 0 && (
                  <div className={`mt-3 rounded border ${T.tile}`}>
                    <div className={`border-b px-2 py-1.5 text-xs font-semibold uppercase tracking-wide ${T.rule} ${T.title}`}>
                      Design rationale — marginal contribution of each asset class
                    </div>
                    <div className="p-2">
                      <table className="w-full text-left font-mono text-sm">
                        <thead>
                          <tr className={`border-b ${T.rule}`}>
                            {["Asset class", "In design", "Rating", "Δ LCOE €/MWh", "Δ renewable pp", "Δ capex M€", "Assessment"].map((h) => (
                              <th key={h} className={`px-1.5 py-1 text-xs font-normal ${T.faint}`}>{h}</th>))}
                          </tr>
                        </thead>
                        <tbody>
                          {sweepOut.contributions.map((c, i) => (
                            <tr key={i} className={`border-b ${T.divide}`}>
                              <td className={`px-1.5 py-0.5 ${T.title}`}>{c.label}</td>
                              <td className={`px-1.5 py-0.5 ${c.inWinner ? T.tone.emerald : T.ghost}`}>{c.inWinner ? "yes" : "no"}</td>
                              <td className="px-1.5 py-0.5">{c.size}</td>
                              <td className={`px-1.5 py-0.5 ${c.deltaLCOE === null ? T.ghost : c.deltaLCOE >= 0 ? T.tone.emerald : T.tone.rose}`}>{c.deltaLCOE === null ? "—" : (c.deltaLCOE >= 0 ? "+" : "") + fmt(c.deltaLCOE, 1)}</td>
                              <td className="px-1.5 py-0.5">{c.deltaRenew === null ? "—" : fmt(c.deltaRenew, 1)}</td>
                              <td className="px-1.5 py-0.5">{c.deltaCapex === null ? "—" : fmt(c.deltaCapex, 2)}</td>
                              <td className={`px-1.5 py-0.5 ${T.muted}`}>{c.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className={`mt-1 text-xs ${T.faint}`}>
                        Δ LCOE compares the selected design against the best compliant design that excludes the asset class
                        entirely (or includes it, where the selected design excludes it) — positive means the selection pays.
                        All comparisons on the merit-order screening basis, so they are like for like.
                        {sweepOut.best.kWp >= sweepOut.space.pv.maxKWp - 100 && sweepOut.space.pv.boundBy === "land available" &&
                          " PV sizing is bound by the land available, not by economics — more land would lower the LCOE further."}
                        {sweepOut.best.unservedMWh > 0.5 &&
                          ` The selected design leaves ${fmt(sweepOut.best.unservedMWh, 0)} MWh/yr unserved — read the energy adequacy detail before presenting it.`}
                      </div>
                    </div>
                  </div>
                )}

                {sweepOut.feasible.length === 0 && (
                  <div className={`mt-3 rounded border px-2 py-2 text-xs ${T.notice.warn}`}>
                    <div className="font-semibold">No candidate passed every check — and the reason is the same for all of them.</div>
                    <div className="mt-1">
                      Of {fmt(sweepOut.tried, 0)} designs tested, the energy check failed on {fmt(sweepOut.failCounts.energy, 0)},
                      the power check on {fmt(sweepOut.failCounts.power, 0)} and the dynamic check on {fmt(sweepOut.failCounts.dynamic, 0)}.
                      A check that fails on every single candidate is not a sizing problem: no amount of PV or storage in this
                      range can fix it, so the requirement itself is what has to change.
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {sweepOut.failCounts.power === sweepOut.tried && (
                        <li>· <strong>Power</strong> fails everywhere. N-1 is being applied because islanding is required, so the
                          grid connection is removed as the largest unit and the site must cover its whole peak without it.
                          Either include generators in the search, or set islanding to “none” if the site is not in fact
                          required to run detached from the grid.</li>
                      )}
                      {sweepOut.failCounts.energy === sweepOut.tried && (
                        <li>· <strong>Energy</strong> fails everywhere. The autonomy requirement needs more stored energy than any
                          battery in this range holds. Raise the top of the battery range, shorten the required autonomy, or
                          reduce the share of load classified as critical.</li>
                      )}
                      {sweepOut.failCounts.dynamic === sweepOut.tried && (
                        <li>· <strong>Dynamic</strong> fails everywhere. The largest load step exceeds the fast response available.
                          Confirm the battery is set to grid-forming, or reduce the load step on the Load tab.</li>
                      )}
                    </ul>
                    <div className="mt-1">
                      The ranking below still shows every design with its cheapest first, so a candidate can be applied and the
                      failing check inspected in detail on the Reliability tab.
                    </div>
                  </div>
                )}

                <div className="mt-3 space-y-3">
                  <div>
                    <div className={`mb-1 text-xs ${T.faint}`}>
                      Candidates ranked by {sweepOut.shortlisted ? "the merit-order screening LCOE; the shortlist carries the optimised price alongside, and the selected design (highlighted) is the cheapest under optimisation" : "LCOE"}.
                      Designs that pass every check are listed first; the rest are still shown, with
                      the check that fails, and any of them can be applied so the failure can be examined on the Reliability tab.
                    </div>
                    <div className={`max-h-96 w-full overflow-auto rounded border ${T.tile}`}>
                      <table className="w-full text-right font-mono text-sm">
                        <thead className={`sticky top-0 ${T.panel}`}>
                          <tr className={`border-b ${T.rule}`}>
                            {["#", "PV MWp", "Wind MW", "BESS MW", "MWh", "Gen", "Gen MWh",
                              sweepOut.shortlisted ? "LCOE screen" : "LCOE €/MWh",
                              ...(sweepOut.shortlisted ? ["LCOE optimised"] : []),
                              "Capex M€", "Renew %", "Checks", "Apply"].map((h) => (
                              <th key={h} className={`px-1.5 py-1 text-xs font-normal ${T.faint}`}>{h}</th>))}
                          </tr>
                        </thead>
                        <tbody>
                          {(sweepOut.ranked || sweepOut.feasible).slice(0, 25).map((r, i) => (
                            <tr key={i} title={r.why || ""} className={`border-b ${T.divide}`}>
                              <td className={`px-1.5 py-0.5 ${T.ghost}`}>{i + 1}</td>
                              <td className="px-1.5 py-0.5">{fmt(r.kWp / 1000, 1)}</td>
                              <td className="px-1.5 py-0.5">{fmt((r.windKW || 0) / 1000, 1)}</td>
                              <td className="px-1.5 py-0.5">{fmt(r.bessKW / 1000, 1)}</td>
                              <td className="px-1.5 py-0.5">{fmt(r.bessKWh / 1000, 1)}</td>
                              <td className="px-1.5 py-0.5">{r.units}</td>
                              <td className={`px-1.5 py-0.5 ${T.ghost}`}>{r.engineMWh !== undefined ? fmt(r.engineMWh, 0) : "—"}</td>
                              <td className={`px-1.5 py-0.5 ${sweepOut.best === r ? T.tone.cyan : ""}`}>{fmt(r.lcoe, 1)}</td>
                              {sweepOut.shortlisted ? (
                                <td className={`px-1.5 py-0.5 ${sweepOut.best === r ? T.tone.cyan : ""}`}>{r.lcoeOpt !== undefined ? fmt(r.lcoeOpt, 1) : "—"}</td>
                              ) : null}
                              <td className="px-1.5 py-0.5">{r.capexMEUR !== undefined ? fmt(r.capexMEUR, 1) : "—"}</td>
                              <td className={`px-1.5 py-0.5 ${T.tone.emerald}`}>{fmt(r.renewablePct, 1)}</td>
                              <td className={`px-1.5 py-0.5 ${r.feasible ? T.tone.emerald : T.tone.rose}`}>
                                {r.feasible ? "pass" : [r.energy === "FAIL" && "energy", r.power === "FAIL" && "power",
                                  r.dynamic === "FAIL" && "dynamic"].filter(Boolean).join(" + ")}
                              </td>
                              <td className="px-1.5 py-0.5">
                                <button onClick={() => applyCandidate(r)} className={`rounded border px-2 py-0.5 text-xs ${i === 0 ? T.chipAlert : T.chip}`}>apply →</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div>
                    <div className={`mb-1 text-xs ${T.faint}`}>LCOE against renewable fraction — the shape of the trade-off, not just the winner</div>
                    <div className="h-80 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart margin={{ top: 8, right: 16, left: 8, bottom: 16 }}>
                          <CartesianGrid stroke={T.chart.grid} />
                          <XAxis type="number" dataKey="renewablePct" name="Renewable" unit="%" tick={axis} height={40}
                            label={{ value: "Renewable fraction (%)", position: "insideBottom", offset: -6, fontSize: 11, fill: T.chart.axis }} />
                          {/* An explicit width and a plain tick format: the axis used to
                              carry its unit on every tick and was clipped by a negative margin. */}
                          <YAxis type="number" dataKey="lcoe" name="LCOE" unit="€/MWh" tick={axis} domain={["auto", "auto"]}
                            width={70} tickFormatter={(v) => fmt(v, 0)}
                            label={{ value: "LCOE (€/MWh)", angle: -90, position: "insideLeft", offset: 4, fontSize: 11, fill: T.chart.axis }} />
                          <Tooltip contentStyle={tip} cursor={{ strokeDasharray: "3 3" }} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Scatter name="Failed a check" data={sweepOut.all.filter((r) => !r.feasible)} fill={T.chart.unservedC} fillOpacity={0.35} />
                          <Scatter name="Passed all checks" data={sweepOut.feasible} fill={T.chart.load} />
                          {sweepOut.best && <Scatter name="Least-LCOE survivor" data={[sweepOut.best]} fill={T.chart.temp} shape="star" />}
                        </ScatterChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </>)}

              {/* Phased build-out */}
              {mode === "aidc" && phaseRows.length > 0 && (
                <div className="mt-4">
                  <div className={`mb-1 text-xs ${T.faint}`}>
                    Phased build-out — the current design evaluated at every ramp year, not only at design load
                  </div>
                  <div className={`overflow-auto rounded border ${T.tile}`}>
                    <table className="w-full text-right font-mono text-xs">
                      <thead className={T.panel}>
                        <tr className={`border-b ${T.rule}`}>
                          {["Year", "MW IT", "Peak MW", "Cap MW", "Engines needed", "Their min load MW", "Below min?", "Unserved MWh", "Energy", "Power", "Dynamic"].map((h) => (
                            <th key={h} className={`px-1.5 py-1 ${T.faint}`}>{h}</th>))}
                        </tr>
                      </thead>
                      <tbody>
                        {phaseRows.map((p, i) => (
                          <tr key={i} className={`border-b ${T.divide} ${p.belowMinLoad ? T.notice.warn : ""}`}>
                            <td className="px-1.5 py-0.5">{p.year}</td>
                            <td className="px-1.5 py-0.5">{fmt(p.mwIT, 1)}</td>
                            <td className="px-1.5 py-0.5">{fmt(p.peakMW, 2)}</td>
                            <td className="px-1.5 py-0.5">{fmt(p.capMW, 1)}</td>
                            <td className="px-1.5 py-0.5">{p.enginesNeeded}</td>
                            <td className="px-1.5 py-0.5">{fmt(p.engineMinMW, 2)}</td>
                            <td className={`px-1.5 py-0.5 ${p.belowMinLoad ? T.tone.rose : T.ghost}`}>{p.belowMinLoad ? "YES" : "no"}</td>
                            <td className="px-1.5 py-0.5">{fmt(p.unservedMWh, 1)}</td>
                            <td className="px-1.5 py-0.5">{p.energy}</td>
                            <td className="px-1.5 py-0.5">{p.power}</td>
                            <td className="px-1.5 py-0.5">{p.dynamic}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {phaseRows.some((p) => p.belowMinLoad) && (
                    <div className={`mt-2 rounded border px-2 py-1 text-xs ${T.notice.warn}`}>
                      In at least one ramp year the engines sit below minimum stable load. A single end-state design will run
                      inefficiently, wet-stack and waste fuel in the early years. Phase the engine build-out, or use smaller
                      units early and add capacity with the load.
                    </div>
                  )}
                </div>
              )}
            </Panel>
          )}

          {/* ================= REPORT ================= */}
          {tab === 11 && (
            <Panel title="Report" step="12" sub="requirement, solution and performance"
              right={
                <div className="flex items-center gap-2">
                <DetailToggle value={detail.report} onChange={(v) => setDetail((s2) => ({ ...s2, report: v }))} />
                <button onClick={doExport} className={`rounded border px-3 py-1 text-xs ${T.chip}`}>Export Excel workbook</button>
                </div>
              }>
              {!runOut ? <NeedsRun /> : (<>
                {/* 1 — WHAT THE PROJECT HAS TO DO */}
                <div className={`rounded border p-3 ${T.tile}`}>
                  <div className={`mb-2 text-xs uppercase tracking-wide ${T.faint}`}>1 · Project requirement</div>
                  <p className={`text-sm ${T.title}`}>
                    {(USE_CASE_FAMILIES[ctx.useCase] || { label: "Use case not set" }).label} at {loc.label}.
                    {mode === "aidc"
                      ? ` A data centre of ${fmt(aidc.targetMWIT, 1)} MW of IT capacity, ${fmt(aidcYearMW, 1)} MW live in the year analysed, ${(CONSTANTS.COOLING[aidc.coolingType] || CONSTANTS.COOLING.air).label.toLowerCase()}, drawing ${fmt(stats.peakKW / 1000, 1)} MW at the busbar.`
                      : ` A site drawing ${fmt(stats.peakKW / 1000, 1)} MW at peak and ${fmt(stats.annualMWh, 0)} MWh a year.`}
                    {gridForBom.enabled
                      ? ` The grid connection allows ${fmt(gridForBom.firmCapKW / 1000, 1)} MW of import${gridForBom.firmCapKW < stats.peakKW ? `, which is ${fmt((stats.peakKW - gridForBom.firmCapKW) / 1000, 1)} MW short of the site peak` : ""}.`
                      : " There is no grid connection, so the site has to make everything it uses."}
                    {ctx.islanding !== "none" && ` It must run for ${fmt(ctx.autonomyH, 0)} hours on its own, carrying the ${fmt(char.critPct, 0)} % of load that cannot be interrupted.`}
                  </p>
                </div>

                {/* 2 — THE SOLUTION */}
                <div className={`mt-3 rounded border p-3 ${T.tile}`}>
                  <div className={`mb-2 text-xs uppercase tracking-wide ${T.faint}`}>2 · Proposed solution</div>
                  <p className={`text-sm ${T.title}`}>
                    {bom.rows.filter((r) => !/inverter/i.test(r.item)).map((r) => `${r.item} ${r.rating}`).join(" · ") || "No equipment selected."}
                  </p>
                  <p className={`mt-1 text-xs ${T.muted}`}>
                    {fmt(bom.installedMW, 1)} MW installed in total, on {fmt(bom.totalAreaM2 / CONSTANTS.M2_PER_HA, 2)} ha,
                    costing {fmt(cost.capex.total / 1e6, 1)} M€ to build
                    {mode === "aidc" ? ` — ${fmt(cost.capex.total / 1e6 / Math.max(0.001, aidcYearMW), 2)} M€ per MW of IT capacity` : ""}.
                  </p>
                  <div className={`mt-3 rounded border p-2 ${T.soft.slate}`}>
                    <SystemDiagram T={T} res={res} gridOn={gridForBom.enabled}
                      gridCapMW={gridForBom.firmCapKW / 1000} loadMW={stats.peakKW / 1000}
                      loadLabel={mode === "aidc" ? "Data centre — IT, cooling and services" : "Site load"}
                      gfSource={res.bess.enabled && res.bess.gridForming ? "bess" : gridForBom.enabled ? "grid" : "engine"} />
                    <div className={`text-xs ${T.faint}`}>
                      Everything meets at one busbar. The item marked “sets the frequency” holds voltage and frequency in an
                      island, so losing it stops the site even if enough megawatts remain.
                    </div>
                  </div>

                  {detail.report === "detail" && (
                    <div className={`mt-3 overflow-auto rounded border ${T.tile}`}>
                      <table className="w-full text-left font-mono text-xs">
                        <thead className={T.panel}>
                          <tr className={`border-b ${T.rule}`}>
                            {["Item", "Qty", "Rating", "Note"].map((h) => <th key={h} className={`px-2 py-1 ${T.faint}`}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {bom.rows.map((r, i) => (
                            <tr key={i} className={`border-b ${T.divide}`}>
                              <td className={`px-2 py-1 ${T.title}`}>{r.item}</td>
                              <td className="px-2 py-1">{r.qty}</td>
                              <td className={`px-2 py-1 ${T.tone.cyan}`}>{r.rating}</td>
                              <td className={`px-2 py-1 ${T.muted}`}>{r.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                    {[["Energy", adeq.energy], ["Power", adeq.power], ["Dynamic", adeq.dynamic]].map(([n, v]) => (
                      <div key={n} className={`flex items-center justify-between gap-2 rounded border px-2 py-1 ${T.panel}`}>
                        <span className={`text-xs ${T.muted}`}>{n} check</span><Badge v={v.verdict} />
                      </div>
                    ))}
                    <div className={`flex items-center justify-between gap-2 rounded border px-2 py-1 ${T.panel}`}>
                      <span className={`text-xs ${T.muted}`}>Overall</span>
                      <Badge v={outcome.allPass ? "PASS" : "FAIL"} />
                    </div>
                  </div>
                </div>

                {/* LCOE against the alternatives — why this design and not another */}
                <div className={`mt-3 rounded border p-3 ${T.tile}`}>
                  <div className={`mb-2 text-xs uppercase tracking-wide ${T.faint}`}>LCOE comparison</div>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={lcoeLadder} margin={{ top: 5, right: 5, left: -10, bottom: 0 }} layout="vertical">
                        <CartesianGrid stroke={T.chart.grid} horizontal={false} />
                        <XAxis type="number" tick={axis} unit=" €" />
                        <YAxis type="category" dataKey="name" tick={axis} width={190} />
                        <Tooltip contentStyle={tip} />
                        <ReferenceLine x={lcoeLadder[0] ? lcoeLadder[0].lcoe : 0} stroke={T.chart.refWarn} strokeDasharray="4 2"
                          label={{ value: "grid only", fill: T.chart.refWarn, fontSize: 10, position: "top" }} />
                        <Bar dataKey="lcoe" name="€/MWh" fill={T.chart.bar1} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className={`mt-1 text-xs ${T.faint}`}>
                    The dashed line is doing nothing — buying every MWh from the grid at {fmt(baseline.annualCost / Math.max(1, baseline.energyMWh), 1)} €/MWh.
                    Anything to the left of it is cheaper than the grid over {fmt(ctx.lifeYears, 0)} years.
                    {sweepOut && sweepOut.feasible.length > 0 && " Auto-size candidates are shown alongside, so you can see whether the chosen design is the cheapest that still passes every check."}
                    {!sweepOut && " Run the sweep on the Auto-size tab to add the alternatives it found."}
                  </div>
                </div>

                {/* 3 — WHAT IT DELIVERS */}
                <div className={`mt-3 rounded border p-3 ${T.tile}`}>
                  <div className={`mb-2 text-xs uppercase tracking-wide ${T.faint}`}>3 · Performance against baseline</div>

                  {outcome.itNow && (
                    <div className="mb-3">
                      <div className={`text-xs ${T.faint}`}>IT capacity supportable at this site</div>
                      <div className="mt-1 grid grid-cols-2 gap-2 md:grid-cols-4">
                        <Stat label="Grid connection alone" value={fmt(outcome.itNow.withoutProject, 1)} unit="MW IT" tone="rose" />
                        <Stat label="With the project" value={fmt(outcome.itNow.withProject, 1)} unit="MW IT" tone="emerald" />
                        <Stat label="Enabled by the project" value={fmt(Math.max(0, outcome.itNow.withProject - outcome.itNow.withoutProject), 1)} unit="MW IT" tone="cyan" />
                        <Stat label="Design target" value={fmt(outcome.itNow.target, 1)} unit="MW IT" />
                      </div>
                      <div className={`mt-1 text-xs ${T.faint}`}>
                        Each MW of IT needs {fmt(outcome.itNow.facilityPerMWIT, 2)} MW at the busbar once cooling and losses are counted,
                        so the {fmt(gridForBom.firmCapKW / 1000, 1)} MW connection on its own supports {fmt(outcome.itNow.withoutProject, 1)} MW of IT.
                      </div>
                    </div>
                  )}

                  <div className={`text-xs ${T.faint}`}>Use-case performance</div>
                  <div className="mt-1 grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Stat label="Peak drawn from the grid" value={fmt(disp.summary.peakImportKW / 1000, 2)} unit="MW" tone="cyan" />
                    <Stat label="Peak reduction at the meter" value={fmt(outcome.peakShavedMW, 2)} unit="MW" tone="emerald" />
                    <Stat label="Demand charge avoided" value={fmt(outcome.demandSavingEUR / 1000, 0)} unit="k€/yr" tone="emerald" />
                    <Stat label="Hours with unserved load" value={fmt(disp.summary.reasonCount[REASON_CODES.indexOf("UNSERVED")], 0)} unit="h/yr"
                      tone={outcome.unservedMWh > 0 ? "rose" : "emerald"} />
                    <Stat label="Renewable share of supply" value={fmt(outcome.renewablePct, 1)} unit="%" tone="emerald" />
                    <Stat label="Island endurance achieved" value={fmt(outcome.autonomyH, 1)} unit={`h of ${fmt(outcome.autonomyRequiredH, 0)} h needed`}
                      tone={outcome.autonomyH >= outcome.autonomyRequiredH ? "emerald" : "amber"} />
                    <Stat label="Fuel burned" value={fmt(outcome.fuelDisplay, 0)} unit={outcome.fuelUnit} />
                    <Stat label="CO₂ avoided against doing nothing" value={fmt(outcome.emissionsAvoidedT, 0)} unit="t/yr" tone="emerald" />
                  </div>

                  <div className={`mt-3 text-xs ${T.faint}`}>Financial performance</div>
                  <div className="mt-1 grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Stat label={lcoeBoundary === "it" ? "Cost per MWh to IT" : "Cost per MWh at the busbar"}
                      value={fmt(lcoeBoundary === "it" ? cost.lcoeIT : cost.lcoeFacility, 1)} unit="€/MWh" tone="cyan" />
                    <Stat label="Cost to build" value={fmt(cost.capex.total / 1e6, 2)} unit="M€" tone="amber" />
                    <Stat label="Baseline annual cost" value={fmt(baseline.annualCost / 1e6, 2)} unit="M€/yr" />
                    <Stat label="Project annual cost" value={fmt((cost.years[0] ? cost.years[0].om + cost.years[0].fuel + cost.years[0].import + cost.years[0].capacity - cost.years[0].export : 0) / 1e6, 2)} unit="M€/yr" />
                    {fin.enabled && financials && <>
                      <Stat label="Saving in year 1" value={fmt(financials.annualSavingY1 / 1e6, 2)} unit="M€/yr" tone="emerald" />
                      <Stat label="NPV over the project life" value={fmt(financials.npv / 1e6, 2)} unit="M€" tone={financials.npv >= 0 ? "emerald" : "rose"} />
                      <Stat label="Project IRR" value={financials.irr === null ? "n/a" : fmt(financials.irr * 100, 1)} unit="%" tone="cyan" />
                      <Stat label="Payback period" value={financials.paybackYears === null ? "never" : fmt(financials.paybackYears, 1)} unit="years" />
                    </>}
                  </div>
                  <div className={`mt-2 text-xs ${T.faint}`}>
                    “Doing nothing” means {baseline.label}. Every saving above is measured against that, so if the comparison is
                    wrong the financial case is wrong with it.
                  </div>
                </div>

                {detail.report === "detail" && (<>
                {/* Energy analytics */}
                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div>
                    <div className={`mb-1 text-xs ${T.faint}`}>Annual energy balance (MWh/yr)</div>
                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={energyBalance} margin={{ top: 5, right: 5, left: -10, bottom: 0 }} layout="vertical">
                          <CartesianGrid stroke={T.chart.grid} horizontal={false} />
                          <XAxis type="number" tick={axis} />
                          <YAxis type="category" dataKey="name" tick={axis} width={95} />
                          <Tooltip contentStyle={tip} />
                          <Bar dataKey="value" name="MWh/yr" fill={T.chart.bar1} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div>
                    <div className={`mb-1 text-xs ${T.faint}`}>Monthly supply mix (MWh)</div>
                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={monthlyMix} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                          <CartesianGrid stroke={T.chart.grid} vertical={false} />
                          <XAxis dataKey="m" tick={axis} />
                          <YAxis tick={axis} />
                          <Tooltip contentStyle={tip} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          {res.pv.enabled && <Bar stackId="a" dataKey="pv" name="Solar PV" fill={T.chart.temp} />}
                          {res.wind.enabled && <Bar stackId="a" dataKey="wind" name="Wind" fill={T.chart.wind} />}
                          {gridForBom.enabled && <Bar stackId="a" dataKey="imp" name="Grid import" fill={T.chart.imp} />}
                          {(res.engine.enabled || res.turbine.enabled) && <Bar stackId="a" dataKey="engine" name="Generators" fill={T.chart.engineC} />}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                {/* Financial model */}
                <div className={`mt-4 rounded border p-2 ${T.tile}`}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className={`text-xs font-semibold uppercase tracking-wide ${T.title}`}>Financial model</span>
                    <Seg value={fin.enabled ? "on" : "off"} onChange={(v) => setFin((s) => ({ ...s, enabled: v === "on" }))}
                      options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]} />
                  </div>
                  {!fin.enabled ? (
                    <div className={`text-xs ${T.faint}`}>
                      Optional. Everything above — sizing, dispatch, adequacy and LCOE — is complete without it.
                    </div>
                  ) : (<>
                    <div className={`mb-2 rounded border px-2 py-1 text-xs ${T.tile} ${T.muted}`}>
                      A microgrid earns no revenue of its own, so the cashflow is the cost it avoids. Baseline: {baseline.label},
                      costing {fmt(baseline.annualCost / 1e6, 2)} M€/yr. Change the baseline and every number below changes with it.
                    </div>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      <Field tier="critical" label="Gearing" unit="% of capex"><Num value={fin.gearingPct} onChange={(v) => setFin((s) => ({ ...s, gearingPct: v }))} /></Field>
                      <Field tier="critical" label="Debt tenor" unit="years"><Num value={fin.tenorYears} onChange={(v) => setFin((s) => ({ ...s, tenorYears: v }))} /></Field>
                      <Field tier="critical" label="Interest rate" unit="%/yr"><Num value={fin.interestPct} step={0.1} onChange={(v) => setFin((s) => ({ ...s, interestPct: v }))} /></Field>
                      <Field label="Credit avoided grid connection" unit="—" hint="deducts the baseline connection cost from capex">
                        <Sel value={fin.creditBaselineCapex ? "yes" : "no"} onChange={(v) => setFin((s) => ({ ...s, creditBaselineCapex: v === "yes" }))}
                          options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]} />
                      </Field>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-6">
                      <Stat label="Net capex" value={fmt(financials.capex / 1e6, 2)} unit="M€" />
                      <Stat label="Year-1 saving" value={fmt(financials.annualSavingY1 / 1e6, 2)} unit="M€/yr" tone="emerald" />
                      <Stat label="NPV" value={fmt(financials.npv / 1e6, 2)} unit="M€" tone={financials.npv >= 0 ? "emerald" : "rose"} />
                      <Stat label="Project IRR" value={financials.irr === null ? "n/a" : fmt(financials.irr * 100, 1)} unit="%" tone="cyan" />
                      <Stat label="Simple payback" value={financials.paybackYears === null ? "never" : fmt(financials.paybackYears, 1)} unit="years" />
                      <Stat label="Minimum DSCR" value={financials.minDSCR === null ? "no debt" : fmt(financials.minDSCR, 2)} unit="×"
                        tone={financials.minDSCR !== null && financials.minDSCR < 1.2 ? "rose" : "emerald"} />
                    </div>
                    <div className="mt-3 h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={financials.rows} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                          <CartesianGrid stroke={T.chart.grid} vertical={false} />
                          <XAxis dataKey="year" tick={axis} />
                          <YAxis yAxisId="l" tick={axis} />
                          <YAxis yAxisId="r" orientation="right" tick={axis} />
                          <Tooltip contentStyle={tip} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Bar yAxisId="l" dataKey="saving" name="Net saving (€)" fill={T.chart.bar1} />
                          <Bar yAxisId="l" dataKey="debtService" name="Debt service (€)" fill={T.chart.engineC} />
                          <Line yAxisId="r" type="monotone" dataKey="dscr" name="DSCR (×)" stroke={T.chart.bessC} dot={false} strokeWidth={1.5} />
                          <ReferenceLine yAxisId="r" y={1.2} stroke={T.chart.refWarn} strokeDasharray="3 3" label={{ value: "1.20×", fill: T.chart.refWarn, fontSize: 10 }} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </>)}
                </div>

                </>)}
                <p className={`mt-2 text-xs ${T.faint}`}>
                  Estimate class AACE 5 (−30 % / +50 %). Pre-feasibility only — not a substitute for a protection study, an EMT
                  study, or a contractor's price. The Excel workbook contains every input and default used, with units.
                </p>
              </>)}
            </Panel>
          )}

          {/* ================= SCENARIOS ================= */}
          {tab === 12 && (
            <Panel title="Compare" step="13" sub="up to six saved in this session"
              right={
                <div className="flex items-center gap-2">
                  <input className={inpCls(T, null)} style={{ width: 160 }} value={scenarioName} placeholder="name this scenario"
                    onChange={(e) => setScenarioName(e.target.value)} />
                  <button onClick={saveScenario} disabled={!runOut || scenarios.length >= 6}
                    className={`rounded border px-3 py-1 text-xs ${!runOut || scenarios.length >= 6 ? T.chipIdle : T.chip}`}>Save current</button>
                </div>
              }>
              {scenarios.length === 0 ? (
                <div className={`rounded border px-2 py-2 text-xs ${T.notice.info}`}>
                  No scenarios saved yet. Run the dispatch, then save the current design here to compare it against others.
                  Scenarios live in this browser session only and are written to the Excel export.
                </div>
              ) : (<>
                <div className={`overflow-auto rounded border ${T.tile}`}>
                  <table className="w-full text-right font-mono text-sm">
                    <thead className={T.panel}>
                      <tr className={`border-b ${T.rule}`}>
                        <th className={`px-2 py-1 text-left text-xs font-normal ${T.faint}`}>Metric</th>
                        {scenarios.map((s, i) => <th key={i} className={`px-2 py-1 text-xs font-normal ${T.title}`}>{s.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {SCENARIO_ROWS.map((row) => (
                        <tr key={row.k} className={`border-b ${T.divide}`}>
                          <td className={`px-2 py-0.5 text-left ${T.muted}`}>{row.label}</td>
                          {scenarios.map((s, i) => {
                            const vals = scenarios.map((x) => x[row.k]);
                            const differs = new Set(vals.map(String)).size > 1;
                            return <td key={i} className={`px-2 py-0.5 ${differs ? T.tone.amber : ""}`}>
                              {typeof s[row.k] === "number" ? fmt(s[row.k], row.d ?? 1) : s[row.k]}
                            </td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className={`mt-1 text-xs ${T.faint}`}>Amber marks a row where the scenarios differ — inputs as well as outputs, so you can see what caused what.</div>

                <div className="mt-3 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={scenarios} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                      <CartesianGrid stroke={T.chart.grid} vertical={false} />
                      <XAxis dataKey="name" tick={axis} />
                      <YAxis yAxisId="l" tick={axis} />
                      <YAxis yAxisId="r" orientation="right" tick={axis} />
                      <Tooltip contentStyle={tip} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar yAxisId="l" dataKey="lcoe" name="LCOE (€/MWh)" fill={T.chart.bar1} />
                      <Bar yAxisId="r" dataKey="renewablePct" name="Renewable (%)" fill={T.chart.temp} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <button onClick={() => setScenarios([])} className={`mt-2 rounded border px-2 py-1 text-xs ${T.btn}`}>Clear all scenarios</button>
              </>)}
            </Panel>
          )}

          {/* ================= CHECKS AND NOTES ================= */}
          {/* Step navigation */}
          {!showInfo && (
          <div className={`flex items-center justify-between gap-3 rounded border p-2 ${T.panel}`}>
            <button disabled={tab === 0} onClick={() => setTab(tab - 1)}
              className={`rounded border px-3 py-1 text-xs ${tab === 0 ? T.chipIdle : T.btn}`}>
              ← Back{tab > 0 ? `: ${TABS[tab - 1].title}` : ""}
            </button>
            <span className={`font-mono text-xs ${T.faint}`}>Step {tab + 1} of {TABS.length} — {TABS[tab].title}</span>
            <button disabled={tab === TABS.length - 1} onClick={() => setTab(tab + 1)}
              className={`rounded border px-3 py-1 text-xs ${tab === TABS.length - 1 ? T.chipIdle : T.chip}`}>
              {tab < TABS.length - 1 ? `Next: ${TABS[tab + 1].title}` : "End"} →
            </button>
          </div>
          )}

          {/* Footer — authorship, build identity and where the data goes */}
          <footer className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t pt-2 text-xs ${T.rule} ${T.faint}`}>
            <span>© {new Date().getFullYear()} {TOOL_RELEASE.author}. All rights reserved.</span>
            <span className="font-mono">
              Version {TOOL_RELEASE.version} · {new Date(TOOL_RELEASE.date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
            </span>
            <span>
              Runs entirely in your browser. Project data, uploaded files and results stay on this computer
              and are never sent to a server.
            </span>
            <button data-mgt-info="method" onClick={() => setShowInfo(true)}
              title="Method note — the mathematics behind the dispatch optimisation"
              className={`flex items-center gap-1.5 rounded border px-2 py-1 ${T.btn}`}>
              <Icon name="info" className="h-3.5 w-3.5" />
              <span>Method note — how the optimisation works</span>
            </button>
          </footer>


        </div>
      </div>
    </ThemeCtx.Provider>
  );
}
