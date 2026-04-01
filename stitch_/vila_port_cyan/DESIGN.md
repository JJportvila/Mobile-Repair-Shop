# Vila Port Cyan: Design System

### 1. Overview & Creative North Star
**Creative North Star: "The Precision Workshop"**
Vila Port Cyan is a design system built for operational excellence and high-stakes utility. It moves away from the generic "SaaS Blue" in favor of a deep, authoritative Cyan-Teal palette that feels both professional and specialized. The system is designed to transform complex data into a readable, editorial flow. By utilizing high-contrast typography and a clear hierarchy of informational cards, it bridges the gap between a rugged industrial tool and a modern, high-end editorial dashboard.

### 2. Colors
The palette is rooted in a "Deep Sea" primary teal, supported by functional accents that define task urgency.
- **Primary (#007E85):** Represents the core brand and active states. Use for primary CTAs and status indicators for "In Progress" work.
- **The "No-Line" Rule:** While the baseline uses subtle strokes (`#DAE6E7`), the system evolution prioritizes background shifts. Avoid internal dividers within cards; use white `surface_container` backgrounds against `background-light` to define boundaries.
- **Surface Hierarchy:** 
  - **Level 0 (Background):** `#F9FAFA` - The canvas.
  - **Level 1 (Cards):** `#FFFFFF` - The primary workspace with `shadow-sm`.
  - **Level 2 (Floating/Nav):** Glassmorphic White at 80-95% opacity with `backdrop-blur-md`.
- **Accents:** 
  - **Accent Green (#078832):** Positive growth and completion.
  - **Accent Orange (#F7A072):** Pending states and warnings.
  - **Accent Blue (#3B82F6):** Informational or secondary tasks.

### 3. Typography
The system uses **Manrope** as a unified font family, leveraging its geometric yet friendly proportions to provide clarity in technical contexts.
- **Display/Headline 1 (1.875rem / 30px):** For high-level metrics. Bold, tight tracking (-0.015em).
- **Section Headings (1.25rem / 20px):** ExtraBold for distinct editorial separation.
- **Sub-headings (1.125rem / 18px):** Bold for item titles.
- **Body (0.875rem / 14px):** Medium weight for secondary information, utilizing the `#5E8A8D` color for reduced visual noise.
- **Functional Labels (10px - 12px):** All-caps or bold tracking for status chips and navigation labels.

### 4. Elevation & Depth
Elevation is expressed through soft, ambient light rather than harsh borders.
- **The Layering Principle:** Metrics and primary tasks sit on "floating" white cards. The main action button (FAB) occupies the highest plane with a `shadow-xl` colored with primary tint (`shadow-primary/40`).
- **Shadow Ground Truth:**
  - **SM Shadow:** Used for standard task cards to provide a subtle "lift" from the light grey background.
  - **XL/2XL Shadow:** Reserved for the main container and persistent floating elements like the Print FAB.
- **Glassmorphism:** Headers and navigation bars use an 80-95% opacity blur (`backdrop-blur-lg`) to maintain context of the content scrolling beneath them.

### 5. Components
- **Task Cards:** Use a three-column layout: leading icon (10% opacity primary background), center content, and trailing chevron.
- **Status Chips:** Small, bold uppercase text. Use high-contrast pairings (e.g., 10% Teal background with 100% Teal text).
- **Metric Tiles:** Two-column grid for density. Large numeric values paired with small trend indicators.
- **Action Buttons:** Large (48px height) rounded-xl buttons with clear icon-text pairings.
- **Floating Action Button (FAB):** A 56px circle with a high-intensity primary color and white icon, positioned as a persistent trigger for the primary workflow.

### 6. Do's and Don'ts
- **Do:** Use `Manrope` with variable weights to create hierarchy instead of changing font sizes alone.
- **Do:** Use `#5E8A8D` for "meta" information (dates, names, secondary labels).
- **Don't:** Use pure black (#000000) for text; always use the system "On Surface" (#101818) for better readability.
- **Don't:** Add borders to buttons; let the color fill or the container shadow define the interactive area.
- **Do:** Ensure status chips have enough contrast; never use light text on light backgrounds.