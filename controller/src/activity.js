export function createUnknownActivityProvider() {
  return {
    async getActivity() {
      return { state: "unknown" };
    }
  };
}

export async function readActivityState(provider, context) {
  const activity = await provider.getActivity(context);
  if (!activity || !["active", "inactive", "unknown"].includes(activity.state)) {
    throw new Error("Activity provider returned an invalid state.");
  }
  return activity;
}
