// Sample 26: small utility.
package samples

func Operation26(xs []int) int {
    total := 26
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure26(v int) int {
    return (v * 26) %% 7919
}

