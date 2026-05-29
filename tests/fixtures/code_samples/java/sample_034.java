// Sample 34: small utility.
package samples;

import java.util.List;

public final class Sample034 {
    private Sample034() {}

    public static int operation(List<Integer> xs) {
        int total = 34;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 34) %% 7919;
    }
}

