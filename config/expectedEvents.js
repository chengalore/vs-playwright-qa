export const expectedEvents = {
  strict: {
    baseline: [
      "user-saw-product",
      "user-saw-widget-button",
      "user-opened-widget",
    ],
    recommendation: ["user-got-size-recommendation"],
    size: ["user-selected-size"],
    panels: ["user-opened-panel-tryiton"],
    wardrobe: ["user-opened-panel-compare"],
    footwear: [
      "user-created-footwear-silhouette",
      "user-opened-panel-rec",
    ],
  },
  refresh: {
    apparel: [
      "user-saw-product",
      "user-saw-widget-button",
      "inpage-mounted",
      "user-got-size-recommendation",
      "user-opened-panel-tryiton",
    ],
    footwear: [
      "user-saw-product",
      "user-saw-widget-button",
      "inpage-mounted",
      "user-selected-size",
      "user-opened-widget",
      "user-opened-panel-rec",
    ],
  },
};
