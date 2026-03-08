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
    kids: [
      "user-opened-widget::kids",
      "user-saw-onboarding-screen::kids",
      "user-selected-gender::kids",
      "user-clicked-age::kids",
      "user-updated-body-measurements::kids",
      "user-completed-onboarding::kids",
      "user-created-silhouette::kids",
      "user-selected-size-kids-rec::kids",
    ],
    gift: [
      "user-selected-gender*",
      "user-selected-age*",
      "user-selected-height*",
      "user-selected-bodyType*",
      "user-opened-panel-rec*",
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
    kids: [
      "user-saw-product",
      "user-saw-widget-button",
      "user-saw-widget-kids",
      "user-selected-size-kids-rec::kids",
    ],
    gift: [
      "user-saw-product",
      "user-saw-widget-button",
      "user-opened-panel-rec",
    ],
  },
};
