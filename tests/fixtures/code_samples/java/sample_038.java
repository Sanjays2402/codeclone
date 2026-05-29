// Sample 38: small utility.
package samples;

import java.util.List;

public final class Sample038 {
    private Sample038() {}

    public static int operation(List<Integer> xs) {
        int total = 38;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 38) %% 7919;
    }
}

