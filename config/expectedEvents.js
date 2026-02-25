export const expectedEvents = {
  strict: {
    baseline: [
      "user-saw-product",
      "user-saw-widget-button",
      "user-opened-widget",
    ],
    recommendation: ["user-got-size-recommendation"],
    size: [
      "user-selected-size", // only required if multiple sizes
    ],
    panels: ["user-opened-panel-tryiton"],
  },
};
